const { google } = require('googleapis');
const mysql = require('mysql2/promise');
const CryptoJS = require('crypto-js');

// Cấu hình khóa bí mật AES
const SECRET_KEY = 'ManNC@2026_SecureKeyAivenMySQL!';

// Cấu hình kết nối Aiven MySQL
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: { 
        rejectUnauthorized: true, 
        ca: process.env.DB_CA_CERT 
    }
};

// Cấu hình Google Drive OAuth2
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });

function decryptData(cipherText) {
    if (!cipherText) return '';
    try {
        const bytes = CryptoJS.AES.decrypt(cipherText, SECRET_KEY);
        const originalText = bytes.toString(CryptoJS.enc.Utf8);
        return originalText || cipherText; 
    } catch (e) {
        return cipherText; 
    }
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const action = req.query.action;
    let connection;

    try {
        if (!action) {
            return res.status(400).json({ success: false, error: 'Thiếu tham số action yêu cầu' });
        }

        connection = await mysql.createConnection(dbConfig);

        // 1. LẤY DỮ LIỆU BAN ĐẦU
        if (action === 'data') {
            const [danh_sach] = await connection.execute('SELECT * FROM danh_sach_tai_san ORDER BY ma_tai_san DESC');
            const [dot_kiem_ke] = await connection.execute('SELECT * FROM dot_kiem_ke ORDER BY id DESC');
            return res.json({ success: true, danh_sach, dot_kiem_ke });
        }

        // 2. PHÂN TRANG DATATABLE DANH MỤC
        if (action === 'server_assets') {
            const draw = parseInt(req.query.draw) || 1;
            const start = parseInt(req.query.start) || 0;
            const length = parseInt(req.query.length) || 10;
            const searchValue = req.query.search && req.query.search.value ? req.query.search.value.trim() : '';

            let baseWhereClause = '';
            let queryParams = [];

            if (searchValue) {
                baseWhereClause = ' WHERE ma_tai_san LIKE ? OR ten_tai_san LIKE ? OR phong_ban_quan_ly LIKE ?';
                const searchParam = `%${searchValue}%`;
                queryParams.push(searchParam, searchParam, searchParam);
            }

            const countQuery = `SELECT COUNT(*) as total FROM danh_sach_tai_san${baseWhereClause}`;
            const [countResult] = await connection.execute(countQuery, queryParams);
            const totalRecords = countResult[0].total;

            const dataQuery = `SELECT * FROM danh_sach_tai_san${baseWhereClause} ORDER BY ma_tai_san DESC LIMIT ${parseInt(length)} OFFSET ${parseInt(start)}`;
            const [rows] = await connection.execute(dataQuery, queryParams);

            return res.json({
                draw: draw,
                recordsTotal: totalRecords,
                recordsFiltered: totalRecords,
                data: rows
            });
        }

        // 3. PHÂN TRANG LỊCH SỬ
        if (action === 'server_history') {
            const draw = parseInt(req.query.draw) || 1;
            const start = parseInt(req.query.start) || 0;
            const length = parseInt(req.query.length) || 10;

            const [countResult] = await connection.execute('SELECT COUNT(*) as total FROM lich_su_kk');
            const totalRecords = countResult[0].total;

            const dataQuery = `SELECT * FROM lich_su_kk ORDER BY id DESC LIMIT ${parseInt(length)} OFFSET ${parseInt(start)}`;
            const [rows] = await connection.execute(dataQuery);

            return res.json({
                draw: draw,
                recordsTotal: totalRecords,
                recordsFiltered: totalRecords,
                data: rows
            });
        }

        // 4. LƯU TỪNG TÀI SẢN LẺ
        if (action === 'save_asset' && req.method === 'POST') {
            const { 
                ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, 
                nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, 
                ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, 
                can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at,
                duplicateAction 
            } = req.body;

            if (!ma_tai_san || !ten_tai_san || !phong_ban_quan_ly) {
                return res.status(400).json({ success: false, error: 'Thiếu trường bắt buộc!' });
            }

            const decryptedNewMaTS = decryptData(ma_tai_san);
            const [allAssets] = await connection.execute('SELECT ma_tai_san FROM danh_sach_tai_san');

            let matchedExistingDbKey = null;
            for (let row of allAssets) {
                if (decryptData(row.ma_tai_san) === decryptedNewMaTS) {
                    matchedExistingDbKey = row.ma_tai_san; 
                    break;
                }
            }

            if (matchedExistingDbKey) {
                if (duplicateAction === 'skip') {
                    return res.json({ success: true, skipped: true });
                }
                await connection.execute(
                    `UPDATE danh_sach_tai_san SET 
                    don_vi = ?, ten_tai_san = ?, nhom_tai_san = ?, 
                    nguyen_gia = ?, hao_mon_luy_ke = ?, gia_tri_con_lai = ?, 
                    ngay_dua_vao_sd = ?, trang_thai_sd = ?, trang_thai_qt = ?, bo_so = ?, 
                    can_bo_su_dung = ?, phong_ban_quan_ly = ?, so_serial = ?, hinh_anh = ?, import_at = ? 
                    WHERE ma_tai_san = ?`,
                    [don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at, matchedExistingDbKey]
                );
                return res.json({ success: true, message: 'Cập nhật thành công!' });
            } else {
                await connection.execute(
                    `INSERT INTO danh_sach_tai_san 
                    (ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at]
                );
                return res.json({ success: true, message: 'Thêm mới thành công!' });
            }
        }

        // 4.1. LƯU TÀI SẢN THEO LÔ (BULK SAVE CHO IMPORT EXCEL)
        if (action === 'save_asset_batch' && req.method === 'POST') {
            const { payloads, duplicateAction } = req.body;

            if (!payloads || !Array.isArray(payloads) || payloads.length === 0) {
                return res.status(400).json({ success: false, error: 'Không có dữ liệu hợp lệ để lưu theo lô!' });
            }

            let successCount = 0;
            let skipCount = 0;
            let batchErrors = [];

            const [allAssets] = await connection.execute('SELECT ma_tai_san FROM danh_sach_tai_san');

            for (let i = 0; i < payloads.length; i++) {
                const p = payloads[i];
                const { 
                    ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, 
                    nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, 
                    ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, 
                    can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at 
                } = p;

                if (!ma_tai_san || !ten_tai_san || !phong_ban_quan_ly) {
                    batchErrors.push(`Dòng ${i + 1}: Thiếu trường bắt buộc.`);
                    continue;
                }

                const decryptedNewMaTS = decryptData(ma_tai_san);
                let matchedExistingDbKey = null;
                for (let row of allAssets) {
                    if (decryptData(row.ma_tai_san) === decryptedNewMaTS) {
                        matchedExistingDbKey = row.ma_tai_san; 
                        break;
                    }
                }

                if (matchedExistingDbKey) {
                    if (duplicateAction === 'skip') {
                        skipCount++;
                        continue;
                    }

                    if (duplicateAction === 'update' || !duplicateAction) {
                        try {
                            await connection.execute(
                                `UPDATE danh_sach_tai_san SET 
                                don_vi = ?, ten_tai_san = ?, nhom_tai_san = ?, 
                                nguyen_gia = ?, hao_mon_luy_ke = ?, gia_tri_con_lai = ?, 
                                ngay_dua_vao_sd = ?, trang_thai_sd = ?, trang_thai_qt = ?, bo_so = ?, 
                                can_bo_su_dung = ?, phong_ban_quan_ly = ?, so_serial = ?, hinh_anh = ?, import_at = ? 
                                WHERE ma_tai_san = ?`,
                                [don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at, matchedExistingDbKey]
                            );
                            successCount++;
                        } catch (updateErr) {
                            batchErrors.push(`Lỗi cập nhật mã ${decryptedNewMaTS}: ${updateErr.message}`);
                        }
                    }
                } else {
                    try {
                        await connection.execute(
                            `INSERT INTO danh_sach_tai_san 
                            (ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at]
                        );
                        successCount++;
                        allAssets.push({ ma_tai_san });
                    } catch (insertErr) {
                        batchErrors.push(`Lỗi thêm mới mã ${decryptedNewMaTS}: ${insertErr.message}`);
                    }
                }
            }

            return res.json({ success: true, successCount, skipCount, errors: batchErrors });
        }

        // 5. XÓA TÀI SẢN
        if (action === 'delete_asset' && req.method === 'POST') {
            const { ma_tai_san } = req.body;
            await connection.execute('DELETE FROM danh_sach_tai_san WHERE ma_tai_san = ?', [ma_tai_san]);
            return res.json({ success: true, message: 'Đã xóa tài sản thành công!' });
        }

        // 6. GHI NHẬN LỊCH SỬ QR
        if (action === 'history' && req.method === 'POST') {
            const { dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu } = req.body;
            await connection.execute(
                'INSERT INTO lich_su_kk (dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu) VALUES (?, ?, ?, ?, ?, ?)',
                [dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu]
            );
            return res.json({ success: true, message: 'Đã ghi nhận lịch sử!' });
        }

        // 7. XÓA LỊCH SỬ
        if (action === 'delete_history' && req.method === 'POST') {
            const { id } = req.body;
            await connection.execute('DELETE FROM lich_su_kk WHERE id = ?', [id]);
            return res.json({ success: true, message: 'Đã xóa lịch sử!' });
        }

        // 8. UPLOAD DRIVE
        if (action === 'upload_drive' && req.method === 'POST') {
            const { fileName, fileData, mimeType } = req.body;
            const base64Data = fileData.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');

            const fileMetadata = { name: fileName, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] };
            const media = { mimeType: mimeType, body: require('stream').Readable.from(buffer) };

            const response = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });
            await drive.permissions.create({ fileId: response.data.id, requestBody: { role: 'reader', type: 'anyone' } });

            const fileUrl = `https://lh3.googleusercontent.com/d/${response.data.id}`;
            return res.json({ success: true, url: fileUrl });
        }

        // 9. XÓA DRIVE
        if (action === 'delete_drive' && req.method === 'POST') {
            const { fileUrl } = req.body;
            if (!fileUrl) return res.status(400).json({ success: false, error: 'Thiếu URL' });

            let fileId = fileUrl.includes('id=') ? fileUrl.split('id=')[1].split('&')[0] : fileUrl.split('/d/')[1].split('/')[0];
            if (!fileId) return res.status(400).json({ success: false, error: 'Không lấy được File ID' });

            await drive.files.delete({ fileId });
            return res.json({ success: true, message: 'Đã xóa file trên Drive' });
        }

        return res.status(404).json({ success: false, error: 'Action không hợp lệ' });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (connection) {
            try { await connection.end(); } catch (e) {}
        }
    }
};
