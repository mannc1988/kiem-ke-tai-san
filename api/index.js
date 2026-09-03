
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
        const action = req.query.action || '';

        try {
            const connection = await pool.getConnection();

            // Tự động tạo bảng nếu chưa tồn tại
            await connection.execute(`CREATE TABLE IF NOT EXISTS danh_sach_ts (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                room VARCHAR(100) NOT NULL
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
                tsName VARCHAR(255),
                nguoiKK VARCHAR(100),
                thoiGian VARCHAR(50),
                ghiChu TEXT
            )`);

            // Chèn dữ liệu mẫu nếu bảng danh mục trống
            const [rows] = await connection.execute("SELECT COUNT(*) as c FROM danh_sach_ts");
            if (rows[0].c === 0) {
                await connection.execute(`INSERT INTO danh_sach_ts (id, name, room) VALUES 
                    ('TS001', 'Máy tính Dell Latitude', 'Phòng Kế Toán'),
                    ('TS002', 'Máy in HP LaserJet', 'Phòng Hành Chính'),
                    ('TS003', 'Bàn làm việc gỗ', 'Phòng Giám Đốc')
                `);
            }
            const [dotRows] = await connection.execute("SELECT COUNT(*) as c FROM dot_kiem_ke");
            if (dotRows[0].c === 0) {
                await connection.execute("INSERT INTO dot_kiem_ke (id, name, active) VALUES ('DOT_01', 'Kiểm kê Quý 1/2026', 1)");
            }

            if (req.method === 'GET' && action === 'data') {
                const [danh_sach] = await connection.execute("SELECT * FROM danh_sach_ts");
                const [dot_kiem_ke] = await connection.execute("SELECT * FROM dot_kiem_ke");
                dot_kiem_ke.forEach(d => d.active = Boolean(d.active));
                const [lich_su] = await connection.execute("SELECT * FROM lich_su_kk");
                connection.release();
                return res.json({ success: true, danh_sach, dot_kiem_ke, lich_su });
            }

            if (req.method === 'POST' && action === 'history') {
                const { dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu } = req.body;
                const [existing] = await connection.execute(
                    "SELECT * FROM lich_su_kk WHERE dotId = ? AND tsId = ?", 
                    [dotId, tsId]
                );
                if (existing.length > 0) {
                    connection.release();
                    return res.status(400).json({ success: false, error: 'Tài sản đã được kiểm kê trước đó!' });
                }
                await connection.execute(
                    "INSERT INTO lich_su_kk (dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu) VALUES (?, ?, ?, ?, ?, ?)",
                    [dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu || 'Quét QR Aiven']
                );
                connection.release();
                return res.json({ success: true });
            }

            connection.release();
            res.status(400).json({ success: false, error: 'Invalid action' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
};
