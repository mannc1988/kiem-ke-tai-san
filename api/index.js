const mysql = require('mysql2/promise');
const cors = require('cors')({ origin: true });

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: { 
        rejectUnauthorized: true, 
        ca: process.env.DB_CA_CERT 
    }
});

module.exports = async (req, res) => {
    return cors(req, res, async () => {
        const action = req.query.action || (req.body && req.body.action) || '';

        try {
            const connection = await pool.getConnection();

            // Khởi tạo bảng danh_sach_tai_san chuẩn kiểu TEXT và LONGTEXT (tự động drop bảng cũ lỗi kiểu dữ liệu)
            await connection.execute(`DROP TABLE IF EXISTS danh_sach_tai_san`);
            await connection.execute(`CREATE TABLE IF NOT EXISTS danh_sach_tai_san (
                id VARCHAR(50) PRIMARY KEY,
                ma_tai_san TEXT,
                don_vi TEXT,
                ten_tai_san TEXT NOT NULL,
                nhom_tai_san TEXT,
                nguyen_gia TEXT,
                hao_mon_luy_ke TEXT,
                gia_tri_con_lai TEXT,
                ngay_dua_vao_sd TEXT,
                trang_thai_sd TEXT,
                bo_so TEXT,
                can_bo_su_dung TEXT,
                phong_ban_quan_ly TEXT,
                so_serial TEXT,
                hinh_anh LONGTEXT
            )`);

            await connection.execute(`CREATE TABLE IF NOT EXISTS dot_kiem_ke (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                active TINYINT DEFAULT 0
            )`);

            await connection.execute(`CREATE TABLE IF NOT EXISTS lich_su_kk (
                id INT AUTO_INCREMENT PRIMARY KEY,
                dotId VARCHAR(50),
                tsId VARCHAR(50),
                tsName TEXT,
                nguoiKK VARCHAR(100),
                thoiGian VARCHAR(50),
                ghiChu TEXT
            )`);

            const [dotRows] = await connection.execute("SELECT COUNT(*) as c FROM dot_kiem_ke");
            if (dotRows[0].c === 0) {
                await connection.execute("INSERT INTO dot_kiem_ke (id, name, active) VALUES ('DOT_01', 'Kiểm kê Quý 1/2026', 1)");
            }

            // 1. GET: Lấy thông tin chung (Cache danh mục & đợt kiểm kê)
            if (req.method === 'GET' && action === 'data') {
                const [danh_sach] = await connection.execute("SELECT * FROM danh_sach_tai_san");
                const [dot_kiem_ke] = await connection.execute("SELECT * FROM dot_kiem_ke");
                dot_kiem_ke.forEach(d => d.active = Boolean(d.active));
                const [lich_su] = await connection.execute("SELECT * FROM lich_su_kk ORDER BY id DESC");
                connection.release();
                return res.json({ success: true, danh_sach, dot_kiem_ke, lich_su });
            }

            // 2. SERVER-SIDE: Bảng Danh Mục Tài Sản
            if (req.method === 'GET' && action === 'server_assets') {
                const draw = parseInt(req.query.draw) || 1;
                const start = parseInt(req.query.start) || 0;
                const length = parseInt(req.query.length) || 10;
                const searchValue = req.query.search && req.query.search.value ? `%${req.query.search.value}%` : '%%';

                const [totalRows] = await connection.execute("SELECT COUNT(*) as total FROM danh_sach_tai_san");
                const totalRecords = totalRows[0].total;

                const searchSql = "WHERE id LIKE ? OR ma_tai_san LIKE ? OR ten_tai_san LIKE ?";
                const [filteredRows] = await connection.execute(
                    `SELECT COUNT(*) as total FROM danh_sach_tai_san ${searchSql}`,
                    [searchValue, searchValue, searchValue]
                );
                const filteredRecords = filteredRows[0].total;

                const query = `SELECT * FROM danh_sach_tai_san ${searchSql} LIMIT ? OFFSET ?`;
                const [data] = await connection.execute(query, [searchValue, searchValue, searchValue, length, start]);

                connection.release();
                return res.json({
                    draw: draw,
                    recordsTotal: totalRecords,
                    recordsFiltered: filteredRecords,
                    data: data
                });
            }

            // 3. SERVER-SIDE: Bảng Lịch Sử Kiểm Kê
            if (req.method === 'GET' && action === 'server_history') {
                const draw = parseInt(req.query.draw) || 1;
                const start = parseInt(req.query.start) || 0;
                const length = parseInt(req.query.length) || 10;
                const searchValue = req.query.search && req.query.search.value ? `%${req.query.search.value}%` : '%%';

                const [totalRows] = await connection.execute("SELECT COUNT(*) as total FROM lich_su_kk");
                const totalRecords = totalRows[0].total;

                const [filteredRows] = await connection.execute(
                    "SELECT COUNT(*) as total FROM lich_su_kk WHERE tsId LIKE ? OR tsName LIKE ? OR nguoiKK LIKE ? OR ghiChu LIKE ?",
                    [searchValue, searchValue, searchValue, searchValue]
                );
                const filteredRecords = filteredRows[0].total;

                const query = `SELECT * FROM lich_su_kk WHERE tsId LIKE ? OR tsName LIKE ? OR nguoiKK LIKE ? OR ghiChu LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`;
                const [data] = await connection.execute(query, [searchValue, searchValue, searchValue, searchValue, length, start]);

                connection.release();
                return res.json({
                    draw: draw,
                    recordsTotal: totalRecords,
                    recordsFiltered: filteredRecords,
                    data: data
                });
            }

            // 4. POST: Lịch sử quét QR
            if (req.method === 'POST' && action === 'history') {
                const { dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu } = req.body;
                const [existing] = await connection.execute("SELECT * FROM lich_su_kk WHERE dotId = ? AND tsId = ?", [dotId, tsId]);
                if (existing.length > 0) {
                    connection.release();
                    return res.status(400).json({ success: false, error: 'Tài sản đã được kiểm kê trước đó trong đợt này!' });
                }
                await connection.execute(
                    "INSERT INTO lich_su_kk (dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu) VALUES (?, ?, ?, ?, ?, ?)", 
                    [dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu || 'Quét QR hệ thống']
                );
                connection.release();
                return res.json({ success: true });
            }

            // 5. POST: Lưu hoặc cập nhật tài sản (Lưu các chuỗi mã hóa AES)
            if (req.method === 'POST' && action === 'save_asset') {
                const { 
                    id, ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, 
                    nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, 
                    ngay_dua_vao_sd, trang_thai_sd, bo_so, 
                    can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh 
                } = req.body;

                if (!id || !ten_tai_san) {
                    connection.release();
                    return res.status(400).json({ success: false, error: 'Vui lòng cung cấp định danh tài sản!' });
                }

                await connection.execute(`
                    INSERT INTO danh_sach_tai_san 
                    (id, ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE 
                        ma_tai_san = VALUES(ma_tai_san),
                        don_vi = VALUES(don_vi),
                        ten_tai_san = VALUES(ten_tai_san),
                        nhom_tai_san = VALUES(nhom_tai_san),
                        nguyen_gia = VALUES(nguyen_gia),
                        hao_mon_luy_ke = VALUES(hao_mon_luy_ke),
                        gia_tri_con_lai = VALUES(gia_tri_con_lai),
                        ngay_dua_vao_sd = VALUES(ngay_dua_vao_sd),
                        trang_thai_sd = VALUES(trang_thai_sd),
                        bo_so = VALUES(bo_so),
                        can_bo_su_dung = VALUES(can_bo_su_dung),
                        phong_ban_quan_ly = VALUES(phong_ban_quan_ly),
                        so_serial = VALUES(so_serial),
                        hinh_anh = VALUES(hinh_anh)
                `, [
                    id, ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, 
                    nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, 
                    ngay_dua_vao_sd, trang_thai_sd, bo_so, 
                    can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh || ''
                ]);

                connection.release();
                return res.json({ success: true, message: 'Lưu tài sản mã hóa thành công!' });
            }

            // 6. POST: Xóa tài sản
            if (req.method === 'POST' && action === 'delete_asset') {
                const { id } = req.body;
                await connection.execute("DELETE FROM danh_sach_tai_san WHERE id = ?", [id]);
                connection.release();
                return res.json({ success: true, message: 'Đã xóa tài sản thành công!' });
            }

            // 7. POST: Xóa lịch sử
            if (req.method === 'POST' && action === 'delete_history') {
                const { id } = req.body;
                await connection.execute("DELETE FROM lich_su_kk WHERE id = ?", [id]);
                connection.release();
                return res.json({ success: true, message: 'Đã xóa lịch sử thành công!' });
            }

            connection.release();
            return res.status(400).json({ success: false, error: 'Invalid action or method' });

        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    });
};
