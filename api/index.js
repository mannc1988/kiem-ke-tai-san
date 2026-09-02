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

            // Tự động khởi tạo cấu trúc bảng mới nếu chưa có
            await connection.execute(`CREATE TABLE IF NOT EXISTS danh_sach_ts (
                id VARCHAR(50) PRIMARY KEY,
                ma_tai_san VARCHAR(100),
                don_vi VARCHAR(255),
                ten_tai_san TEXT NOT NULL,
                nhom_tai_san VARCHAR(255),
                nguyen_gia DECIMAL(15,2) DEFAULT 0,
                hao_mon_luy_ke DECIMAL(15,2) DEFAULT 0,
                gia_tri_con_lai DECIMAL(15,2) DEFAULT 0,
                ngay_dua_vao_sd VARCHAR(50),
                trang_thai_sd VARCHAR(100),
                bo_so VARCHAR(100),
                can_bo_su_dung TEXT,
                phong_ban_quan_ly TEXT,
                so_serial VARCHAR(100)
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

            // Chèn đợt kiểm kê mẫu nếu bảng trống
            const [dotRows] = await connection.execute("SELECT COUNT(*) as c FROM dot_kiem_ke");
            if (dotRows[0].c === 0) {
                await connection.execute("INSERT INTO dot_kiem_ke (id, name, active) VALUES ('DOT_01', 'Kiểm kê Quý 1/2026', 1)");
            }

            // 1. GET: Lấy thông tin chung (Đợt kiểm kê & cache danh mục tài sản)
            if (req.method === 'GET' && action === 'data') {
                const [danh_sach] = await connection.execute("SELECT * FROM danh_sach_ts");
                const [dot_kiem_ke] = await connection.execute("SELECT * FROM dot_kiem_ke");
                dot_kiem_ke.forEach(d => d.active = Boolean(d.active));
                const [lich_su] = await connection.execute("SELECT * FROM lich_su_kk ORDER BY id DESC");
                connection.release();
                return res.json({ success: true, danh_sach, dot_kiem_ke, lich_su });
            }

            // 2. SERVER-SIDE: Bảng Danh Mục Tài Sản (Cấu trúc mới với Paging, Search, Order)
            if (req.method === 'GET' && action === 'server_assets') {
                const draw = parseInt(req.query.draw) || 1;
                const start = parseInt(req.query.start) || 0;
                const length = parseInt(req.query.length) || 10;
                const searchValue = req.query.search && req.query.search.value ? `%${req.query.search.value}%` : '%%';

                // Bản đồ cột sắp xếp tương ứng với bảng giao diện mới
                const columnsMap = { 
                    0: 'id', 
                    1: 'ma_tai_san', 
                    2: 'ten_tai_san', 
                    3: 'nhom_tai_san', 
                    4: 'phong_ban_quan_ly', 
                    5: 'can_bo_su_dung', 
                    6: 'nguyen_gia', 
                    7: 'so_serial' 
                };
                let orderBy = 'ma_tai_san';
                let orderDir = 'ASC';
                if (req.query.order && req.query.order[0]) {
                    const colIdx = req.query.order[0].column;
                    orderBy = columnsMap[colIdx] || 'ma_tai_san';
                    orderDir = req.query.order[0].dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
                }

                // Tổng số bản ghi gốc
                const [totalRows] = await connection.execute("SELECT COUNT(*) as total FROM danh_sach_ts");
                const totalRecords = totalRows[0].total;

                // Tổng số bản ghi sau khi tìm kiếm
                const searchSql = "WHERE ma_tai_san LIKE ? OR ten_tai_san LIKE ? OR phong_ban_quan_ly LIKE ? OR can_bo_su_dung LIKE ? OR so_serial LIKE ?";
                const [filteredRows] = await connection.execute(
                    `SELECT COUNT(*) as total FROM danh_sach_ts ${searchSql}`,
                    [searchValue, searchValue, searchValue, searchValue, searchValue]
                );
                const filteredRecords = filteredRows[0].total;

                // Lấy dữ liệu phân trang
                const query = `SELECT * FROM danh_sach_ts ${searchSql} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`;
                const [data] = await connection.execute(query, [searchValue, searchValue, searchValue, searchValue, searchValue, length, start]);

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

                const historyColumnsMap = { 0: 'id', 1: 'tsId', 2: 'tsName', 3: 'nguoiKK', 4: 'thoiGian', 5: 'ghiChu' };
                let orderBy = 'id';
                let orderDir = 'DESC';
                if (req.query.order && req.query.order[0]) {
                    const colIdx = req.query.order[0].column;
                    orderBy = historyColumnsMap[colIdx] || 'id';
                    orderDir = req.query.order[0].dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
                }

                const [totalRows] = await connection.execute("SELECT COUNT(*) as total FROM lich_su_kk");
                const totalRecords = totalRows[0].total;

                const [filteredRows] = await connection.execute(
                    "SELECT COUNT(*) as total FROM lich_su_kk WHERE tsId LIKE ? OR tsName LIKE ? OR nguoiKK LIKE ? OR ghiChu LIKE ?",
                    [searchValue, searchValue, searchValue, searchValue]
                );
                const filteredRecords = filteredRows[0].total;

                const query = `SELECT * FROM lich_su_kk WHERE tsId LIKE ? OR tsName LIKE ? OR nguoiKK LIKE ? OR ghiChu LIKE ? ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`;
                const [data] = await connection.execute(query, [searchValue, searchValue, searchValue, searchValue, length, start]);

                connection.release();
                return res.json({
                    draw: draw,
                    recordsTotal: totalRecords,
                    recordsFiltered: filteredRecords,
                    data: data
                });
            }

            // 4. POST: Ghi nhận lịch sử quét QR kiểm kê
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

            // 5. POST: Lưu hoặc cập nhật tài sản (Hỗ trợ cấu trúc đầy đủ các trường mới)
            if (req.method === 'POST' && action === 'save_asset') {
                const { 
                    id, ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, 
                    nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, 
                    ngay_dua_vao_sd, trang_thai_sd, bo_so, 
                    can_bo_su_dung, phong_ban_quan_ly, so_serial 
                } = req.body;

                const assetId = id || ma_tai_san;
                if (!assetId || !ten_tai_san) {
                    connection.release();
                    return res.status(400).json({ success: false, error: 'Vui lòng cung cấp Mã tài sản và Tên tài sản!' });
                }

                await connection.execute(`
                    INSERT INTO danh_sach_ts 
                    (id, ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        so_serial = VALUES(so_serial)
                `, [
                    assetId, ma_tai_san || assetId, don_vi || '', ten_tai_san, nhom_tai_san || '', 
                    nguyen_gia || 0, hao_mon_luy_ke || 0, gia_tri_con_lai || 0, 
                    ngay_dua_vao_sd || '', trang_thai_sd || 'Đang sử dụng', bo_so || '', 
                    can_bo_su_dung || '', phong_ban_quan_ly || '', so_serial || ''
                ]);

                connection.release();
                return res.json({ success: true, message: 'Lưu thông tin tài sản thành công!' });
            }

            // 6. POST: Xóa tài sản
            if (req.method === 'POST' && action === 'delete_asset') {
                const { id } = req.body;
                await connection.execute("DELETE FROM danh_sach_ts WHERE id = ? OR ma_tai_san = ?", [id, id]);
                connection.release();
                return res.json({ success: true, message: 'Đã xóa tài sản thành công!' });
            }

            // 7. POST: Xóa lịch sử kiểm kê
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
