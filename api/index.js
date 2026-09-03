const { google } = require('googleapis');
const mysql = require('mysql2/promise');
const CryptoJS = require('crypto-js');

// Cấu hình khóa bí mật AES (giống bên Frontend)
const SECRET_KEY = 'ManNC@2026_SecureKeyAivenMySQL!';

// Cấu hình kết nối cơ sở dữ liệu Aiven MySQL (Thay thế thông tin thực tế của bạn)
const dbConfig = {
    host: process.env.DB_HOST || 'your-mysql-host.aivencloud.com',
    user: process.env.DB_USER || 'avnadmin',
    password: process.env.DB_PASSWORD || 'your_password',
    database: process.env.DB_NAME || 'defaultdb',
    port: process.env.DB_PORT || 16324,
    ssl: { rejectUnauthorized: false }
};

// Cấu hình Google Drive OAuth2 / Service Account (Sử dụng thông tin xác thực của bạn)
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Hàm hỗ trợ giải mã AES dữ liệu nhận từ client nếu cần
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
    // Cấu hình CORS cho phép gọi API từ giao diện Frontend
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const action = req.query.action;
    let connection;

    try {
        connection = await mysql.createConnection(dbConfig);

        // 1. LẤY DỮ LIỆU BAN ĐẦU & DANH MỤC ĐỢT KIỂM KÊ
        if (action === 'data') {
            const [danh_sach] = await connection.execute('SELECT * FROM danh_sach_tai_san ORDER BY id DESC');
            const [dot_kiem_ke] = await connection.execute('SELECT * FROM dot_kiem_ke ORDER BY id DESC');
            return res.json({ success: true, danh_sach, dot_kiem_ke });
        }

        // 2. PHÂN TRANG DATATABLE CHO DANH MỤC TÀI SẢN
        if (action === 'server_assets') {
            const draw = parseInt(req.query.draw) || 1;
            const start = parseInt(req.query.start) || 0;
            const length = parseInt(req.query.length) || 10;
            const searchValue = req.query.search && req.query.search.value ? req.query.search.value : '';

            let query = 'SELECT * FROM danh_sach_tai_san';
            let countQuery = 'SELECT COUNT(*) as total FROM danh_sach_tai_san';
            let queryParams = [];

            if (searchValue) {
                query += ' WHERE ma_tai_san LIKE ? OR ten_tai_san LIKE ? OR phong_ban_quan_ly LIKE ?';
                countQuery += ' WHERE ma_tai_san LIKE ? OR ten_tai_san LIKE ? OR phong_ban_quan_ly LIKE ?';
                const searchParam = `%${searchValue}%`;
                queryParams = [searchParam, searchParam, searchParam];
            }

            const [countResult] = await connection.execute(countQuery, queryParams);
            const totalRecords = countResult[0].total;

            query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
            queryParams.push(length, start);

            const [rows] = await connection.query(query, queryParams);

            return res.json({
                draw: draw,
                recordsTotal: totalRecords,
                recordsFiltered: totalRecords,
                data: rows
            });
        }

        // 3. PHÂN TRANG DATATABLE CHO LỊCH SỬ KIỂM KÊ
        if (action === 'server_history') {
            const draw = parseInt(req.query.draw) || 1;
            const start = parseInt(req.query.start) || 0;
            const length = parseInt(req.query.length) || 10;

            const [countResult] = await connection.execute('SELECT COUNT(*) as total FROM lich_su_kiem_ke');
            const totalRecords = countResult[0].total;

            const [rows] = await connection.execute(
                'SELECT * FROM lich_su_kiem_ke ORDER BY id DESC LIMIT ? OFFSET ?',
                [length, start]
            );

            return res.json({
                draw: draw,
                recordsTotal: totalRecords,
                recordsFiltered: totalRecords,
                data: rows
            });
        }

        // 4. LƯU / CẬP NHẬT TÀI SẢN
        if (action === 'save_asset' && req.method === 'POST') {
            const { 
                id, ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, 
                nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, 
                ngay_dua_vao_sd, trang_thai_sd, bo_so, 
                can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh 
            } = req.body;

            // Kiểm tra xem tài sản đã tồn tại chưa (dựa vào mã tài sản hoặc id)
            const [existing] = await connection.execute(
                'SELECT id FROM danh_sach_tai_san WHERE id = ? OR ma_tai_san = ?', 
                [id, ma_tai_san]
            );

            if (existing.length > 0) {
                // Cập nhật tài sản
                await connection.execute(
                    `UPDATE danh_sach_tai_san SET 
                    ma_tai_san = ?, don_vi = ?, ten_tai_san = ?, nhom_tai_san = ?, 
                    nguyen_gia = ?, hao_mon_luy_ke = ?, gia_tri_con_lai = ?, 
                    ngay_dua_vao_sd = ?, trang_thai_sd = ?, bo_so = ?, 
                    can_bo_su_dung = ?, phong_ban_quan_ly = ?, so_serial = ?, hinh_anh = ? 
                    WHERE id = ?`,
                    [
                        ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, 
                        nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, 
                        ngay_dua_vao_sd, trang_thai_sd, bo_so, 
                        can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, existing[0].id
                    ]
                );
            } else {
                // Thêm mới tài sản
                await connection.execute(
                    `INSERT INTO danh_sach_tai_san 
                    (id, ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        id, ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, 
                        nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, 
                        ngay_dua_vao_sd, trang_thai_sd, bo_so, 
                        can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh
                    ]
                );
            }

            return res.json({ success: true, message: 'Lưu tài sản thành công!' });
        }

        // 5. XÓA TÀI SẢN
        if (action === 'delete_asset' && req.method === 'POST') {
            const { id } = req.body;
            await connection.execute('DELETE FROM danh_sach_tai_san WHERE id = ?', [id]);
            return res.json({ success: true, message: 'Đã xóa tài sản thành công!' });
        }

        // 6. GHI NHẬN LỊCH SỬ QUÉT KIỂM KÊ QR
        if (action === 'history' && req.method === 'POST') {
            const { dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu } = req.body;
            await connection.execute(
                'INSERT INTO lich_su_kiem_ke (dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu) VALUES (?, ?, ?, ?, ?, ?)',
                [dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu]
            );
            return res.json({ success: true, message: 'Đã ghi nhận lịch sử kiểm kê!' });
        }

        // 7. XÓA LỊCH SỬ KIỂM KÊ
        if (action === 'delete_history' && req.method === 'POST') {
            const { id } = req.body;
            await connection.execute('DELETE FROM lich_su_kiem_ke WHERE id = ?', [id]);
            return res.json({ success: true, message: 'Đã xóa lịch sử thành công!' });
        }

        // 8. UPLOAD ẢNH LÊN GOOGLE DRIVE
        if (action === 'upload_drive' && req.method === 'POST') {
            const { fileName, fileData, mimeType } = req.body;
            const base64Data = fileData.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');

            const fileMetadata = {
                name: fileName,
                parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] // Thư mục lưu trữ trên Drive của bạn
            };

            const media = {
                mimeType: mimeType,
                body: require('stream').Readable.from(buffer)
            };

            const response = await drive.files.create({
                resource: fileMetadata,
                media: media,
                fields: 'id, webViewLink, webContentLink'
            });

            // Set quyền public/view cho file để hiển thị trực tiếp trên web
            await drive.permissions.create({
                fileId: response.data.id,
                requestBody: { role: 'reader', type: 'anyone' }
            });

            const fileUrl = `https://lh3.googleusercontent.com/d/${response.data.id}`;

            return res.json({ success: true, url: fileUrl, fileId: response.data.id });
        }

        // 9. XÓA ẢNH KHỎI GOOGLE DRIVE KHI NGƯỜI DÙNG LOẠI BỎ TRÊN GIAO DIỆN
        if (action === 'delete_drive' && req.method === 'POST') {
            const { fileUrl } = req.body;
            if (!fileUrl) {
                return res.status(400).json({ success: false, error: 'Thiếu URL file cần xóa' });
            }

            let fileId = '';
            if (fileUrl.includes('id=')) {
                fileId = fileUrl.split('id=')[1].split('&')[0];
            } else if (fileUrl.includes('/d/')) {
                fileId = fileUrl.split('/d/')[1].split('/')[0];
            }

            if (!fileId) {
                return res.status(400).json({ success: false, error: 'Không thể trích xuất File ID từ URL' });
            }

            // Thực hiện xóa vĩnh viễn file trên Google Drive
            await drive.files.delete({ fileId: fileId });

            return res.json({ success: true, message: 'Đã xóa file thành công trên Google Drive' });
        }

        return res.status(404).json({ success: false, error: 'Action không hợp lệ' });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (connection) await connection.end();
    }
};
