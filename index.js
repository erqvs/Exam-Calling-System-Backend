const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = 3001; // 后端服务器端口

// 中间件
app.use(cors());
app.use(bodyParser.json());

// 配置数据库连接
const db = mysql.createConnection({
    host: 'localhost',  // 根据你的数据库配置修改
    user: 'root',        // 根据你的数据库用户修改
    password: '123456', // 根据你的数据库密码修改
    database: 'call'  // 使用你之前的数据库名字
});

// 连接数据库
db.connect((err) => {
    if (err) {
        console.error('数据库连接失败:', err);
        return;
    }
    console.log('已连接到 MySQL 数据库');
});

// 添加学生到队列的 API 端点
app.post('/api/queue/add', (req, res) => {
    const { idCardNumber, name } = req.body;
    const sql = 'INSERT INTO queue_info (id_card, name, sign_in_time) VALUES (?, ?, NOW())';
    db.query(sql, [idCardNumber, name], (err, result) => {
        if (err) {
            console.error('数据库插入失败:', err);
            return res.status(500).json({ error: '数据库插入失败' });
        }
        res.json({ message: '学生已添加到队列' });

        // 通知所有客户端更新队列状态
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send('update_queue'); // 发送更新消息
            }
        });
    });
});


// 获取考生队列状态的 API 端点
app.get('/api/queue/status', (req, res) => {
    const sqlCurrent = 'SELECT name FROM queue_info WHERE seat_number IS NOT NULL ORDER BY call_time DESC LIMIT 1';
    const sqlWaiting = 'SELECT id, name, sign_in_time FROM queue_info WHERE seat_number IS NULL ORDER BY sign_in_time ASC LIMIT 15';

    db.query(sqlCurrent, (err, currentResult) => {
        if (err) {
            console.error('获取当前考生失败:', err);
            return res.status(500).json({ error: '获取当前考生失败' });
        }

        db.query(sqlWaiting, (err, waitingResult) => {
            if (err) {
                console.error('获取等待考生失败:', err);
                return res.status(500).json({ error: '获取等待考生失败' });
            }

            res.json({
                currentStudent: currentResult.length > 0 ? currentResult[0].name : null,
                waitingStudents: waitingResult
            });
        });
    });
});

// 获取当前排队状态的 API 端点
app.get('/api/queue/list', (req, res) => {
    const sql = 'SELECT * FROM queue_info ORDER BY sign_in_time ASC'; // 按退出时间排序
    db.query(sql, (err, results) => {
        if (err) {
            console.error('数据库查询失败:', err);
            return res.status(500).json({ error: '数据库查询失败' });
        }
        res.json(results);
    });
});

// 获取下一个学生的姓名 API 端点
app.get('/api/queue/next', (req, res) => {
    const sql = 'SELECT id, name FROM queue_info WHERE seat_number IS NULL ORDER BY sign_in_time ASC LIMIT 1';
    db.query(sql, (err, results) => {
        if (err) {
            console.error('获取下一个学生失败:', err);
            return res.status(500).json({ error: '获取下一个学生失败' });
        }
        if (results.length > 0) {
            res.json({ student: results[0] });
        } else {
            res.json({ student: null });
        }
    });
});

// 通知下一个学生的 API 端点
app.post('/api/queue/notify', (req, res) => {
    const { seatNumber } = req.body;
    const selectSql = 'SELECT id, name FROM queue_info WHERE seat_number IS NULL ORDER BY sign_in_time ASC LIMIT 1';
    db.query(selectSql, (selectErr, selectResults) => {
        if (selectErr) {
            console.error('获取下一个学生的ID失败:', selectErr);
            return res.status(500).json({ error: '获取下一个学生的ID失败' });
        }
        if (selectResults.length === 0) {
            return res.json({ message: '没有学生需要被通知' });
        }
        const studentId = selectResults[0].id;
        const studentName = selectResults[0].name;
        const studentInfo = `${studentId} - ${studentName}`;
        const updateSql = 'UPDATE queue_info SET seat_number = ?, call_time = NOW() WHERE id = ?';
        db.query(updateSql, [seatNumber, studentId], (updateErr, updateResults) => {
            if (updateErr) {
                console.error('通知学生失败:', updateErr);
                return res.status(500).json({ error: '通知学生失败' });
            }

            // 更新 exam_rooms 表中的 current_student 字段
            const updateRoomSql = 'UPDATE exam_rooms SET current_student = ? WHERE room_info = ?';
            db.query(updateRoomSql, [studentInfo, seatNumber], (roomErr, roomResults) => {
                if (roomErr) {
                    console.error('更新考场当前考生失败:', roomErr);
                    return res.status(500).json({ error: '更新考场当前考生失败' });
                }

                res.json({ message: `已通知学生到 ${seatNumber} 号座位考试`, student: { id: studentId, name: studentName } });

                // 向所有客户端广播更新信息，并传递学生和考场信息
                const calloutMessage = `callout:${studentInfo}:${seatNumber}`;
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(calloutMessage);
                        client.send('update_queue'); // 添加更新队列的消息
                    }
                });
            });
        });
    });
});


// 清除 queue_info 数据并重置 AUTO_INCREMENT 的 API 端点
app.post('/api/queue/clear', (req, res) => {
    const clearSql = 'TRUNCATE TABLE queue_info'; // 清除数据并重置 AUTO_INCREMENT
    db.query(clearSql, (err, result) => {
        if (err) {
            console.error('清除数据失败:', err);
            return res.status(500).json({ error: '清除数据失败' });
        }
        res.json({ message: '队列信息已清除，计数器已重置' });
    });
});

// 添加考场的 API 端点
app.post('/api/exam_rooms/add', (req, res) => {
    const { roomInfo } = req.body;

    // 检查是否存在相同的考场名称
    const checkSql = 'SELECT COUNT(*) AS count FROM exam_rooms WHERE room_info = ?';
    db.query(checkSql, [roomInfo], (checkErr, checkResults) => {
        if (checkErr) {
            console.error('数据库查询失败:', checkErr);
            return res.status(500).json({ error: '数据库查询失败' });
        }

        if (checkResults[0].count > 0) {
            return res.status(400).json({ error: '考场名称已存在，请使用不同的名称' });
        }

        // 如果没有重复的考场名称，则插入新的考场
        const sql = 'INSERT INTO exam_rooms (room_info) VALUES (?)';
        db.query(sql, [roomInfo], (err, result) => {
            if (err) {
                console.error('数据库插入失败:', err);
                return res.status(500).json({ error: '数据库插入失败' });
            }
            res.json({ message: '考场已添加' });

            // 通知所有客户端更新考场列表
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send('update_rooms');
                }
            });
        });
    });
});




// 获取考场列表的 API 端点
app.get('/api/exam_rooms', (req, res) => {
    const sql = 'SELECT room_info, current_student FROM exam_rooms';
    db.query(sql, (err, results) => {
        if (err) {
            console.error('数据库查询失败:', err);
            return res.status(500).json({ error: '数据库查询失败' });
        }
        res.json(results); // 返回包含考场名称和当前考生的完整信息
    });
});

// 删除考场的 API 端点
app.post('/api/exam_rooms/delete', (req, res) => {
    const { rooms } = req.body; // 接收前端发送的要删除的考场数组
    if (!rooms || rooms.length === 0) {
        return res.status(400).json({ error: '请选择要删除的考场' });
    }

    const placeholders = rooms.map(() => '?').join(', '); // 生成占位符字符串，例如 "?, ?, ?"
    const sql = `DELETE FROM exam_rooms WHERE room_info IN (${placeholders})`;

    db.query(sql, rooms, (err, result) => {
        if (err) {
            console.error('批量删除考场失败:', err);
            return res.status(500).json({ error: '批量删除考场失败' });
        }
        res.json({ message: '考场已删除' });

        // 发送 WebSocket 消息，通知前端更新
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send('update_rooms');
            }
        });
    });
});




// index.js

const http = require('http');
const WebSocket = require('ws');

// 创建 HTTP 服务器
const server = http.createServer(app);

// 创建 WebSocket 服务器，并将其附加到 HTTP 服务器
const wss = new WebSocket.Server({ server });

// 处理 WebSocket 连接
wss.on('connection', (ws) => {
    console.log('新的客户端连接');

    ws.on('message', (message) => {
        console.log(`收到消息: ${message}`);
        // 广播消息给所有已连接的客户端
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });

    ws.on('close', () => {
        console.log('客户端断开连接');
    });
});

// 启动 HTTP 服务器
server.listen(port, () => {
    console.log(`HTTP 服务器正在运行，访问 http://localhost:${port}`);
    console.log('WebSocket 服务器正在运行，监听同一个 HTTP 服务器');
});
