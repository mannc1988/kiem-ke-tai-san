const mysql = require('mysql2/promise');
const CryptoJS = require('crypto-js');
const fetch = require('node-fetch');

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

function encryptData(plainText) {
    if (plainText === undefined || plainText === null || plainText === '') return '';
    return CryptoJS.AES.encrypt(plainText.toString(), SECRET_KEY).toString();
}

function decryptData(cipherText) {
    if (!cipherText) return '';
    try {
        const bytes = CryptoJS.AES.decrypt(cipherText.toString(), SECRET_KEY);
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

        // 1. LẤY DỮ LIỆU BAN ĐẦU (TỰ ĐỘNG GIẢI MÃ TÊN ĐỢT KIỂM KÊ VỀ CLIENT)
        if (action === 'data') {
            const [danh_sach] = await connection.execute('SELECT * FROM danh_sach_tai_san ORDER BY ma_tai_san DESC');
            const [dotRows] = await connection.execute('SELECT * FROM dot_kiem_ke ORDER BY id DESC');
            const [lich_su] = await connection.execute('SELECT * FROM lich_su_kk ORDER BY id DESC');
            
            // Giải mã tên đợt kiểm kê nếu đã lưu mã hóa trong CSDL
            const dot_kiem_ke = dotRows.map(d => ({
                ...d,
                name: decryptData(d.name)
            }));

            return res.json({ success: true, danh_sach, dot_kiem_ke, lich_su });
        }

        // 1.1 TẠO MỚI ĐỢT KIỂM KÊ (DÙNG ID TỰ TĂNG AUTO_INCREMENT)
        if (action === 'add_dot' && req.method === 'POST') {
            const { name } = req.body;
            if (!name || !name.trim()) {
                return res.status(400).json({ success: false, error: 'Tên đợt kiểm kê không được để trống!' });
            }

            const rawName = decryptData(name).trim();
            const encName = encryptData(rawName);

            // Bảng dot_kiem_ke có id là AUTO_INCREMENT nên chỉ cần INSERT cột name
            const [result] = await connection.execute(
                'INSERT INTO dot_kiem_ke (name) VALUES (?)',
                [encName]
            );

            return res.json({ 
                success: true, 
                id: result.insertId, // Lấy ID tự tăng vừa tạo từ MySQL
                name: rawName,
                message: 'Đã tạo đợt kiểm kê mới thành công!' 
            });
        }

        // 1.2 CẬP NHẬT ĐỢT KIỂM KÊ (THEO ID TỰ TĂNG)
        if (action === 'update_dot' && req.method === 'POST') {
            const { id, name } = req.body;
            if (!id || !name || !name.trim()) {
                return res.status(400).json({ success: false, error: 'Thiếu ID hoặc tên đợt kiểm kê cần cập nhật!' });
            }

            const cleanId = parseInt(id, 10);
            const rawName = decryptData(name).trim();
            const encName = encryptData(rawName);

            const [result] = await connection.execute(
                'UPDATE dot_kiem_ke SET name = ? WHERE id = ?',
                [encName, cleanId]
            );

            if (result.affectedRows > 0) {
                return res.json({ success: true, message: 'Đã cập nhật đợt kiểm kê thành công!' });
            } else {
                return res.status(404).json({ success: false, error: 'Không tìm thấy đợt kiểm kê cần cập nhật!' });
            }
        }

        // 1.3 XÓA ĐỢT KIỂM KÊ (THEO ID TỰ TĂNG)
        if (action === 'delete_dot' && req.method === 'POST') {
            const { id } = req.body;
            if (!id) {
                return res.status(400).json({ success: false, error: 'Thiếu ID đợt kiểm kê cần xóa!' });
            }

            const cleanId = parseInt(id, 10);

            const [result] = await connection.execute(
                'DELETE FROM dot_kiem_ke WHERE id = ?',
                [cleanId]
            );

            if (result.affectedRows > 0) {
                return res.json({ success: true, message: 'Đã xóa đợt kiểm kê thành công!' });
            } else {
                return res.status(404).json({ success: false, error: 'Không tìm thấy đợt kiểm kê cần xóa!' });
            }
        }

        // 2. PHÂN TRANG DATATABLE DANH MỤC TÀI SẢN
        if (action === 'server_assets') {
            const draw = parseInt(req.query.draw) || 1;
            const start = parseInt(req.query.start) || 0;
            const length = parseInt(req.query.length) || 10;
            const searchValue = req.query.search && req.query.search.value ? req.query.search.value.trim() : '';

            let baseWhereClause = '';
            let searchParams = [];

            if (searchValue) {
                baseWhereClause = ' WHERE ma_tai_san LIKE ? OR ten_tai_san LIKE ? OR phong_ban_quan_ly LIKE ?';
                const searchParam = `%${searchValue}%`;
                searchParams = [searchParam, searchParam, searchParam];
            }

            const [totalResult] = await connection.execute('SELECT COUNT(*) as total FROM danh_sach_tai_san');
            const totalRecords = totalResult[0].total;

            const countQuery = `SELECT COUNT(*) as total FROM danh_sach_tai_san${baseWhereClause}`;
            const [filteredResult] = await connection.execute(countQuery, searchParams);
            const recordsFiltered = filteredResult[0].total;

            const limitVal = Math.max(1, parseInt(length));
            const offsetVal = Math.max(0, parseInt(start));
            
            const dataQuery = `SELECT * FROM danh_sach_tai_san${baseWhereClause} ORDER BY ma_tai_san DESC LIMIT ? OFFSET ?`;
            const [rows] = await connection.execute(dataQuery, [...searchParams, limitVal, offsetVal]);

            return res.json({
                draw: draw,
                recordsTotal: totalRecords,
                recordsFiltered: recordsFiltered,
                data: rows
            });
        }

        // 3. PHÂN TRANG DATATABLE LỊCH SỬ KIỂM KÊ
        if (action === 'server_history') {
            const draw = parseInt(req.query.draw) || 1;
            const start = parseInt(req.query.start) || 0;
            const length = parseInt(req.query.length) || 10;
            const selectedDotId = req.query.dot_id ? String(req.query.dot_id).trim() : '';

            const [allRows] = await connection.execute('SELECT * FROM lich_su_kk ORDER BY id DESC');
            
            let filteredRows = allRows;
            if (selectedDotId) {
                filteredRows = allRows.filter(row => {
                    const decryptedDotId = decryptData(row.dotId).trim();
                    return decryptedDotId === selectedDotId || String(row.dotId).trim() === selectedDotId;
                });
            }

            const totalRecords = allRows.length;
            const recordsFiltered = filteredRows.length;
            const paginatedRows = filteredRows.slice(start, start + length);

            return res.json({
                draw: draw,
                recordsTotal: totalRecords,
                recordsFiltered: recordsFiltered,
                data: paginatedRows
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

        // 4.1. LƯU TÀI SẢN THEO LÔ
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
            
            if (!ma_tai_san) {
                return res.status(400).json({ success: false, error: 'Thiếu mã tài sản cần xóa!' });
            }

            const targetMaTS = ma_tai_san.toString().trim();
            const [allAssets] = await connection.execute('SELECT ma_tai_san FROM danh_sach_tai_san');

            let matchedDbKey = null;
            for (let row of allAssets) {
                let decMa = decryptData(row.ma_tai_san).trim();
                if (decMa === targetMaTS || row.ma_tai_san === targetMaTS) {
                    matchedDbKey = row.ma_tai_san;
                    break;
                }
            }

            if (!matchedDbKey) {
                return res.status(404).json({ success: false, error: 'Không tìm thấy mã tài sản cần xóa trong CSDL!' });
            }

            const [result] = await connection.execute('DELETE FROM danh_sach_tai_san WHERE ma_tai_san = ?', [matchedDbKey]);

            if (result.affectedRows > 0) {
                return res.json({ success: true, message: 'Đã xóa tài sản thành công!' });
            } else {
                return res.status(500).json({ success: false, error: 'Xóa thất bại, không có dòng nào bị ảnh hưởng!' });
            }
        }

        // 6. GHI NHẬN LỊCH SỬ QR
        if (action === 'history' && req.method === 'POST') {
            const { 
                tsId, phong_ban, so_serial, nguoiKK, ghiChu, 
                dotId, ket_qua_kk, phuong_an_xl, tep_dinh_kem, thoiGian, tsName 
            } = req.body;

            if (!dotId || !tsId) {
                return res.status(400).json({ success: false, error: 'Thiếu thông tin Đợt kiểm kê hoặc Mã tài sản!' });
            }

            const rawTargetDotId = decryptData(dotId).trim();
            const rawTargetTsId = decryptData(tsId).trim();

            const [allHistories] = await connection.execute('SELECT dotId, tsId FROM lich_su_kk');

            let isDuplicate = false;
            for (let row of allHistories) {
                const dbDotIdDecrypted = decryptData(row.dotId).trim();
                const dbTsIdDecrypted = decryptData(row.tsId).trim();

                if (dbDotIdDecrypted === rawTargetDotId && dbTsIdDecrypted === rawTargetTsId) {
                    isDuplicate = true;
                    break;
                }
            }

            if (isDuplicate) {
                return res.status(200).json({ 
                    success: false, 
                    error: `Tài sản [${rawTargetTsId}] đã được kiểm kê trong đợt này!` 
                });
            }

            const encTsId = encryptData(rawTargetTsId);
            const encPhongBan = encryptData(decryptData(phong_ban));
            const encSerial = encryptData(decryptData(so_serial));
            const encNguoiKK = encryptData(decryptData(nguoiKK));
            const encGhiChu = encryptData(decryptData(ghiChu));
            const encDotId = encryptData(rawTargetDotId);
            const encKetQua = encryptData(decryptData(ket_qua_kk || 'Khớp danh mục'));
            const encPhuongAn = encryptData(decryptData(phuong_an_xl || 'Giữ nguyên'));
            const encTepDinhKem = encryptData(decryptData(tep_dinh_kem || ''));
            const encThoiGian = encryptData(decryptData(thoiGian));
            const encTsName = encryptData(decryptData(tsName));

            await connection.execute(
                `INSERT INTO lich_su_kk 
                (tsId, phong_ban, so_serial, nguoiKK, ghiChu, dotId, ket_qua_kk, phuong_an_xl, tep_dinh_kem, thoiGian, tsName) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [encTsId, encPhongBan, encSerial, encNguoiKK, encGhiChu, encDotId, encKetQua, encPhuongAn, encTepDinhKem, encThoiGian, encTsName]
            );

            return res.json({ success: true, message: 'Đã ghi nhận lịch sử kiểm kê!' });
        }

        // 7. XÓA LỊCH SỬ
        if (action === 'delete_history' && req.method === 'POST') {
            const { id } = req.body;
            await connection.execute('DELETE FROM lich_su_kk WHERE id = ?', [id]);
            return res.json({ success: true, message: 'Đã xóa lịch sử!' });
        }

        // 7.1. CẬP NHẬT LỊCH SỬ KIỂM KÊ
        if (action === 'update_history' && req.method === 'POST') {
            const { id, phong_ban, so_serial, nguoiKK, ket_qua_kk, phuong_an_xl, tep_dinh_kem, ghiChu } = req.body;

            if (!id) {
                return res.status(400).json({ success: false, error: 'Thiếu ID lịch sử cần cập nhật!' });
            }

            const encPhongBan = encryptData(decryptData(phong_ban));
            const encSerial = encryptData(decryptData(so_serial));
            const encNguoiKK = encryptData(decryptData(nguoiKK));
            const encKetQua = encryptData(decryptData(ket_qua_kk));
            const encPhuongAn = encryptData(decryptData(phuong_an_xl));
            const encTepDinhKem = encryptData(decryptData(tep_dinh_kem || ''));
            const encGhiChu = encryptData(decryptData(ghiChu));

            await connection.execute(
                `UPDATE lich_su_kk SET 
                phong_ban = ?, so_serial = ?, nguoiKK = ?, ket_qua_kk = ?, phuong_an_xl = ?, tep_dinh_kem = ?, ghiChu = ? 
                WHERE id = ?`,
                [encPhongBan, encSerial, encNguoiKK, encKetQua, encPhuongAn, encTepDinhKem, encGhiChu, id]
            );

            return res.json({ success: true, message: 'Đã cập nhật lịch sử thành công!' });
        }

        // 8. UPLOAD MỌI LOẠI FILE QUA GOOGLE APPS SCRIPT WEB APP
        if (action === 'upload_drive' && req.method === 'POST') {
            const { fileName, fileData, mimeType } = req.body;
            const SCRIPT_WEB_APP_URL = process.env.GOOGLE_SCRIPT_WEB_APP_URL;

            if (!SCRIPT_WEB_APP_URL) {
                return res.status(500).json({ success: false, error: 'Chưa cấu hình GOOGLE_SCRIPT_WEB_APP_URL trong biến môi trường!' });
            }

            const response = await fetch(SCRIPT_WEB_APP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'upload', fileName, fileData, mimeType })
            });

            const textRes = await response.text();
            try {
                return res.json(JSON.parse(textRes));
            } catch (err) {
                return res.status(500).json({ success: false, error: 'Lỗi phản hồi từ Google Drive (không phải JSON).' });
            }
        }

        // 9. XÓA DRIVE THỰC TẾ QUA GOOGLE APPS SCRIPT
        if (action === 'delete_drive' && req.method === 'POST') {
            const { fileUrl, fileId } = req.body;
            const SCRIPT_WEB_APP_URL = process.env.GOOGLE_SCRIPT_WEB_APP_URL;

            if (!SCRIPT_WEB_APP_URL) {
                return res.status(500).json({ success: false, error: 'Chưa cấu hình GOOGLE_SCRIPT_WEB_APP_URL!' });
            }

            if (!fileUrl && !fileId) {
                return res.status(400).json({ success: false, error: 'Thiếu fileUrl hoặc fileId để xóa!' });
            }

            const response = await fetch(SCRIPT_WEB_APP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    action: 'delete_drive', 
                    fileUrl: fileUrl, 
                    fileId: fileId 
                })
            });

            const textRes = await response.text();
            try {
                return res.json(JSON.parse(textRes));
            } catch (err) {
                return res.status(500).json({ success: false, error: 'Lỗi phản hồi từ Google Drive (không phải JSON).' });
            }
        }

        // 10. LOẠI BỎ TỆP DANH MỤC TÀI SẢN KHỎI CSDL
        if (action === 'remove_asset_file' && req.method === 'POST') {
            const { ma_tai_san, removeUrl } = req.body;
            
            if (!ma_tai_san || !removeUrl) {
                return res.status(400).json({ success: false, error: 'Thiếu mã tài sản hoặc URL tệp cần xóa!' });
            }

            const [allAssets] = await connection.execute('SELECT ma_tai_san, hinh_anh FROM danh_sach_tai_san');

            let matchedDbKey = null;
            let currentHinhAnhEncrypted = '';

            for (let row of allAssets) {
                let decMa = decryptData(row.ma_tai_san);
                if (decMa === ma_tai_san || row.ma_tai_san === ma_tai_san) {
                    matchedDbKey = row.ma_tai_san;
                    currentHinhAnhEncrypted = row.hinh_anh;
                    break;
                }
            }

            if (!matchedDbKey) {
                return res.status(404).json({ success: false, error: 'Không tìm thấy tài sản trong CSDL!' });
            }

            let decryptedHinhAnh = decryptData(currentHinhAnhEncrypted) || '';
            let urlList = decryptedHinhAnh.split(',').map(s => s.trim()).filter(Boolean);
            let updatedList = urlList.filter(url => url !== removeUrl.trim());
            
            let newHinhAnhEncrypted = encryptData(updatedList.join(','));

            await connection.execute(
                'UPDATE danh_sach_tai_san SET hinh_anh = ? WHERE ma_tai_san = ?', 
                [newHinhAnhEncrypted, matchedDbKey]
            );

            return res.json({ 
                success: true, 
                message: 'Đã cập nhật CSDL thành công!',
                remainingUrls: updatedList.join(',')
            });
        }

        // 11. LOẠI BỎ TỆP LỊCH SỬ KIỂM KÊ KHỎI CSDL
        if (action === 'remove_history_file' && req.method === 'POST') {
            const id = req.body.id || req.body.historyId;
            const removeUrl = req.body.removeUrl;
            
            if (!id || id === 'null' || !removeUrl) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Thiếu ID lịch sử hoặc URL tệp cần xóa!' 
                });
            }

            const cleanId = Number(id);
            const cleanRemoveUrl = removeUrl.toString().trim();

            const [rows] = await connection.execute('SELECT tep_dinh_kem FROM lich_su_kk WHERE id = ?', [cleanId]);

            if (rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Không tìm thấy dòng lịch sử trong CSDL!' });
            }

            let decryptedTep = decryptData(rows[0].tep_dinh_kem) || '';
            let urlList = decryptedTep.split(',').map(s => s.trim()).filter(Boolean);
            let updatedList = urlList.filter(url => url !== cleanRemoveUrl);
            
            let newTepEncrypted = encryptData(updatedList.join(','));

            await connection.execute(
                'UPDATE lich_su_kk SET tep_dinh_kem = ? WHERE id = ?', 
                [newTepEncrypted, cleanId]
            );

            return res.json({ 
                success: true, 
                message: 'Đã cập nhật tệp đính kèm lịch sử trong CSDL thành công!',
                remainingUrls: updatedList.join(',')
            });
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
