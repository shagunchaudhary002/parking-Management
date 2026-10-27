require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// MySQL database connection
const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "smart_parking",
    waitForConnections: true,
    connectionLimit: 10
});

const PARKING_RATE = 30; // ₹30 per hour

// Dashboard statistics
app.get("/api/dashboard", async (req, res) => {
    try {
        const [slots] = await pool.query(`
            SELECT
                COUNT(*) AS total,
                COALESCE(SUM(status = 'AVAILABLE'), 0) AS available,
                COALESCE(SUM(status = 'OCCUPIED'), 0) AS occupied,
                COALESCE(SUM(status = 'RESERVED'), 0) AS reserved
            FROM parking_slots
        `);

        const [revenue] = await pool.query(`
            SELECT COALESCE(SUM(fee), 0) AS revenue
            FROM parking_sessions
            WHERE status = 'COMPLETED'
        `);

        res.json({
            ...slots[0],
            revenue: Number(revenue[0].revenue)
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Could not load dashboard."
        });
    }
});

// Get all parking slots
app.get("/api/slots", async (req, res) => {
    try {
        const [slots] = await pool.query(`
            SELECT
                s.id,
                s.slot_number,
                s.status,
                p.customer_name,
                p.vehicle_number
            FROM parking_slots s
            LEFT JOIN parking_sessions p
                ON p.slot_id = s.id
                AND p.status IN ('ACTIVE', 'RESERVED')
            ORDER BY s.slot_number
        `);

        res.json(slots);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Could not load slots." });
    }
});

// Get recent parking records
app.get("/api/sessions", async (req, res) => {
    try {
        const [sessions] = await pool.query(`
            SELECT
                p.id,
                p.customer_name,
                p.vehicle_number,
                s.slot_number,
                p.entry_time,
                p.exit_time,
                p.fee,
                p.status
            FROM parking_sessions p
            JOIN parking_slots s ON s.id = p.slot_id
            ORDER BY p.id DESC
            LIMIT 100
        `);

        res.json(sessions);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Could not load records." });
    }
});

// Vehicle entry
app.post("/api/entry", async (req, res) => {
    const { customer_name, vehicle_number, slot_id } = req.body;

    if (
        !customer_name?.trim() ||
        !vehicle_number?.trim() ||
        !Number.isInteger(Number(slot_id))
    ) {
        return res.status(400).json({
            message: "Enter customer name, vehicle number and valid slot."
        });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [slots] = await connection.query(
            "SELECT * FROM parking_slots WHERE id = ? FOR UPDATE",
            [Number(slot_id)]
        );

        if (!slots.length || slots[0].status !== "AVAILABLE") {
            await connection.rollback();
            return res.status(409).json({
                message: "This slot is not available."
            });
        }

        const [active] = await connection.query(
            `SELECT id FROM parking_sessions
             WHERE vehicle_number = ?
             AND status IN ('ACTIVE', 'RESERVED')`,
            [vehicle_number.trim().toUpperCase()]
        );

        if (active.length) {
            await connection.rollback();
            return res.status(409).json({
                message: "This vehicle already has an active parking record."
            });
        }

        await connection.query(
            `INSERT INTO parking_sessions
             (customer_name, vehicle_number, slot_id, status)
             VALUES (?, ?, ?, 'ACTIVE')`,
            [
                customer_name.trim(),
                vehicle_number.trim().toUpperCase(),
                Number(slot_id)
            ]
        );

        await connection.query(
            "UPDATE parking_slots SET status = 'OCCUPIED' WHERE id = ?",
            [Number(slot_id)]
        );

        await connection.commit();

        res.status(201).json({ message: "Vehicle entry recorded successfully." });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ message: "Vehicle entry failed." });
    } finally {
        connection.release();
    }
});

// Reserve a parking slot
app.post("/api/bookings", async (req, res) => {
    const { customer_name, vehicle_number, slot_id } = req.body;

    if (
        !customer_name?.trim() ||
        !vehicle_number?.trim() ||
        !Number.isInteger(Number(slot_id))
    ) {
        return res.status(400).json({
            message: "Enter customer name, vehicle number and valid slot."
        });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [slots] = await connection.query(
            "SELECT * FROM parking_slots WHERE id = ? FOR UPDATE",
            [Number(slot_id)]
        );

        if (!slots.length || slots[0].status !== "AVAILABLE") {
            await connection.rollback();
            return res.status(409).json({
                message: "This slot is not available for booking."
            });
        }

        const [existing] = await connection.query(
            `SELECT id FROM parking_sessions
             WHERE vehicle_number = ?
             AND status IN ('ACTIVE', 'RESERVED')`,
            [vehicle_number.trim().toUpperCase()]
        );

        if (existing.length) {
            await connection.rollback();
            return res.status(409).json({
                message: "This vehicle already has an active booking."
            });
        }

        await connection.query(
            `INSERT INTO parking_sessions
             (customer_name, vehicle_number, slot_id, status)
             VALUES (?, ?, ?, 'RESERVED')`,
            [
                customer_name.trim(),
                vehicle_number.trim().toUpperCase(),
                Number(slot_id)
            ]
        );

        await connection.query(
            "UPDATE parking_slots SET status = 'RESERVED' WHERE id = ?",
            [Number(slot_id)]
        );

        await connection.commit();

        res.status(201).json({ message: "Parking slot booked successfully." });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ message: "Booking failed." });
    } finally {
        connection.release();
    }
});

// Vehicle exit and parking fee calculation
app.post("/api/exit", async (req, res) => {
    const { session_id } = req.body;

    if (!Number.isInteger(Number(session_id)) || Number(session_id) <= 0) {
        return res.status(400).json({ message: "Invalid parking record." });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [records] = await connection.query(
            `SELECT * FROM parking_sessions
             WHERE id = ? AND status = 'ACTIVE'
             FOR UPDATE`,
            [Number(session_id)]
        );

        if (!records.length) {
            await connection.rollback();
            return res.status(404).json({
                message: "Active parking record not found."
            });
        }

        const record = records[0];
        const entryTime = new Date(record.entry_time);
        const elapsedMs = Date.now() - entryTime.getTime();
        const hours = Math.max(1, Math.ceil(elapsedMs / 3600000));
        const fee = hours * PARKING_RATE;

        await connection.query(
            `UPDATE parking_sessions
             SET exit_time = NOW(), fee = ?, status = 'COMPLETED'
             WHERE id = ?`,
            [fee, record.id]
        );

        await connection.query(
            "UPDATE parking_slots SET status = 'AVAILABLE' WHERE id = ?",
            [record.slot_id]
        );

        await connection.commit();

        res.json({
            message: "Vehicle exit recorded successfully.",
            hours,
            rate_per_hour: PARKING_RATE,
            fee
        });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ message: "Vehicle exit failed." });
    } finally {
        connection.release();
    }
});

// Cancel a reservation
app.post("/api/bookings/:id/cancel", async (req, res) => {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [records] = await connection.query(
            `SELECT * FROM parking_sessions
             WHERE id = ? AND status = 'RESERVED'
             FOR UPDATE`,
            [req.params.id]
        );

        if (!records.length) {
            await connection.rollback();
            return res.status(404).json({
                message: "Reservation not found."
            });
        }

        await connection.query(
            `UPDATE parking_sessions SET status = 'COMPLETED'
             WHERE id = ?`,
            [records[0].id]
        );

        await connection.query(
            "UPDATE parking_slots SET status = 'AVAILABLE' WHERE id = ?",
            [records[0].slot_id]
        );

        await connection.commit();
        res.json({ message: "Reservation cancelled." });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ message: "Could not cancel reservation." });
    } finally {
        connection.release();
    }
});

// Activate a reserved booking when the vehicle arrives
app.post("/api/bookings/:id/checkin", async (req, res) => {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [records] = await connection.query(
            `SELECT * FROM parking_sessions
             WHERE id = ? AND status = 'RESERVED'
             FOR UPDATE`,
            [req.params.id]
        );

        if (!records.length) {
            await connection.rollback();
            return res.status(404).json({
                message: "Active reservation not found."
            });
        }

        await connection.query(
            `UPDATE parking_sessions
             SET status = 'ACTIVE', entry_time = NOW()
             WHERE id = ?`,
            [records[0].id]
        );

        await connection.query(
            "UPDATE parking_slots SET status = 'OCCUPIED' WHERE id = ?",
            [records[0].slot_id]
        );

        await connection.commit();
        res.json({ message: "Reserved vehicle checked in successfully." });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ message: "Check-in failed." });
    } finally {
        connection.release();
    }
});

// Start server after verifying the database connection
async function startServer() {
    try {
        await pool.query("SELECT 1");

        const port = process.env.PORT || 3000;

        app.listen(port, () => {
            console.log(`Smart Parking running at http://localhost:${port}`);
        });
    } catch (error) {
        console.error("Database connection failed:", error.message);
        process.exit(1);
    }
}

startServer();
