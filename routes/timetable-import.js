// routes/timetable-import.js
import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import pool from '../database/db.js';
import { protect, adminOnly } from '../middlewares/authMiddleware.js';
import { IMPORT_CONFIG } from '../config/importConfig.js';
import { enqueueImportJob, enqueueBookingGeneration } from '../services/importQueue.js';

await fs.mkdir(IMPORT_CONFIG.uploadDir, { recursive: true });

const router = express.Router();

// Extensions matching IMPORT_CONFIG.allowedMimeTypes above
const ALLOWED_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.csv'];

// Multer config — store files on disk with UUID-only names. file.originalname
// is attacker-controlled and must never be used to build the filesystem path
// (it can contain "../" segments) — only its extension is taken, and even
// that is validated against a whitelist before use.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMPORT_CONFIG.uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error(`Unsupported file extension: ${ext}`));
    }
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: IMPORT_CONFIG.maxFileSizeMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (IMPORT_CONFIG.allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
    }
  },
});

// ==============================
// POST /timetable-import/jobs — create a new import job
// ==============================
router.post('/jobs', protect, adminOnly, async (req, res) => {
  const { name, semester, effective_from } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name is required' });

  try {
    const result = await pool.query(
      `INSERT INTO timetable_import_jobs (name, semester, effective_from, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, semester || null, effective_from || null, req.user.id]
    );
    res.status(201).json({ success: true, job: result.rows[0] });
  } catch (err) {
    console.error('Error creating import job:', err);
    res.status(500).json({ success: false, error: 'Failed to create import job' });
  }
});

// ==============================
// POST /timetable-import/jobs/:jobId/files — upload files to a job
// ==============================
router.post(
  '/jobs/:jobId/files',
  protect,
  adminOnly,
  upload.array('files', 10),
  async (req, res) => {
    const { jobId } = req.params;

    try {
      const jobCheck = await pool.query(
        'SELECT id, status FROM timetable_import_jobs WHERE id = $1',
        [jobId]
      );
      if (!jobCheck.rows.length) {
        return res.status(404).json({ success: false, error: 'Import job not found' });
      }
      if (jobCheck.rows[0].status !== 'CREATED') {
        return res
          .status(409)
          .json({ success: false, error: 'Files can only be added to a CREATED job' });
      }
      if (!req.files || !req.files.length) {
        return res.status(400).json({ success: false, error: 'No files uploaded' });
      }

      const savedFiles = [];
      for (const file of req.files) {
        const result = await pool.query(
          `INSERT INTO timetable_import_files
             (job_id, original_filename, storage_path, mime_type, file_size_bytes)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [jobId, file.originalname, file.path, file.mimetype, file.size]
        );
        savedFiles.push(result.rows[0]);
      }

      res.status(201).json({ success: true, files: savedFiles });
    } catch (err) {
      console.error('Error uploading import files:', err);
      res.status(500).json({ success: false, error: 'Failed to upload files' });
    }
  }
);

// ==============================
// POST /timetable-import/jobs/:jobId/start — trigger extraction pipeline
// ==============================
router.post('/jobs/:jobId/start', protect, adminOnly, async (req, res) => {
  const { jobId } = req.params;

  try {
    const jobCheck = await pool.query(
      `SELECT j.*, COUNT(f.id) AS file_count
       FROM timetable_import_jobs j
       LEFT JOIN timetable_import_files f ON f.job_id = j.id
       WHERE j.id = $1 GROUP BY j.id`,
      [jobId]
    );

    if (!jobCheck.rows.length) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    const job = jobCheck.rows[0];
    if (job.status !== 'CREATED') {
      return res.status(409).json({ success: false, error: 'Job already started' });
    }
    if (parseInt(job.file_count) === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    await enqueueImportJob(jobId);

    await pool.query(
      `UPDATE timetable_import_jobs SET status = 'PROCESSING', updated_at = NOW() WHERE id = $1`,
      [jobId]
    );

    res.json({ success: true, message: 'Extraction pipeline started', jobId });
  } catch (err) {
    console.error('Error starting import job:', err);
    res.status(500).json({ success: false, error: 'Failed to start extraction pipeline' });
  }
});

// ==============================
// GET /timetable-import/jobs — list all import jobs
// ==============================
router.get('/jobs', protect, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT j.*, COUNT(f.id) AS file_count, p.full_name AS created_by_name
       FROM timetable_import_jobs j
       LEFT JOIN timetable_import_files f ON f.job_id = j.id
       LEFT JOIN profiles p ON p.id = j.created_by
       GROUP BY j.id, p.full_name
       ORDER BY j.created_at DESC`
    );
    res.json({ success: true, jobs: result.rows });
  } catch (err) {
    console.error('Error listing import jobs:', err);
    res.status(500).json({ success: false, error: 'Failed to list import jobs' });
  }
});

// ==============================
// GET /timetable-import/jobs/:jobId — get a single job with all details
// ==============================
router.get('/jobs/:jobId', protect, adminOnly, async (req, res) => {
  const { jobId } = req.params;

  try {
    const [jobRes, filesRes, lecturesRes, conflictsRes] = await Promise.all([
      pool.query('SELECT * FROM timetable_import_jobs WHERE id = $1', [jobId]),
      pool.query('SELECT * FROM timetable_import_files WHERE job_id = $1', [jobId]),
      pool.query(
        'SELECT * FROM timetable_extracted_lectures WHERE job_id = $1 ORDER BY created_at',
        [jobId]
      ),
      pool.query(
        'SELECT * FROM timetable_import_conflicts WHERE job_id = $1 ORDER BY severity DESC, created_at',
        [jobId]
      ),
    ]);

    if (!jobRes.rows.length) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    res.json({
      success: true,
      job: jobRes.rows[0],
      files: filesRes.rows,
      lectures: lecturesRes.rows,
      conflicts: conflictsRes.rows,
    });
  } catch (err) {
    console.error('Error fetching import job:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch import job' });
  }
});

// ==============================
// PATCH /timetable-import/jobs/:jobId/lectures/:lectureId — admin edits a lecture
// ==============================
router.patch('/jobs/:jobId/lectures/:lectureId', protect, adminOnly, async (req, res) => {
  const { lectureId } = req.params;
  const allowedFields = [
    'teacher_name', 'subject', 'room_number', 'weekday_number',
    'start_time', 'duration_minutes', 'batch', 'lecture_type',
  ];

  const updates = Object.entries(req.body).filter(([k]) => allowedFields.includes(k));
  if (!updates.length) {
    return res.status(400).json({ success: false, error: 'No valid fields provided' });
  }

  try {
    const current = await pool.query('SELECT * FROM timetable_extracted_lectures WHERE id = $1', [lectureId]);
    if (!current.rows.length) {
      return res.status(404).json({ success: false, error: 'Lecture not found' });
    }

    for (const [field, newValue] of updates) {
      await pool.query(
        `INSERT INTO timetable_admin_corrections (lecture_id, field_name, old_value, new_value, edited_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [lectureId, field, String(current.rows[0][field] ?? ''), String(newValue), req.user.id]
      );
    }

    const setClauses = updates.map(([k], i) => `${k} = $${i + 1}`).join(', ');
    const values = updates.map(([, v]) => v);
    const updated = await pool.query(
      `UPDATE timetable_extracted_lectures
       SET ${setClauses}, updated_at = NOW()
       WHERE id = $${values.length + 1} RETURNING *`,
      [...values, lectureId]
    );

    res.json({ success: true, lecture: updated.rows[0] });
  } catch (err) {
    console.error('Error updating extracted lecture:', err);
    res.status(500).json({ success: false, error: 'Failed to update lecture' });
  }
});

// ==============================
// DELETE /timetable-import/jobs/:jobId/lectures/:lectureId — reject a lecture
// ==============================
router.delete('/jobs/:jobId/lectures/:lectureId', protect, adminOnly, async (req, res) => {
  const { lectureId } = req.params;
  try {
    await pool.query(
      `UPDATE timetable_extracted_lectures
       SET status = 'REJECTED', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [req.user.id, lectureId]
    );
    res.status(204).send();
  } catch (err) {
    console.error('Error rejecting extracted lecture:', err);
    res.status(500).json({ success: false, error: 'Failed to reject lecture' });
  }
});

// ==============================
// PATCH /timetable-import/jobs/:jobId/conflicts/:conflictId/resolve
// ==============================
router.patch('/jobs/:jobId/conflicts/:conflictId/resolve', protect, adminOnly, async (req, res) => {
  const { conflictId } = req.params;
  try {
    const result = await pool.query(
      `UPDATE timetable_import_conflicts
       SET resolved = TRUE, resolved_by = $1, resolved_at = NOW()
       WHERE id = $2 RETURNING *`,
      [req.user.id, conflictId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, error: 'Conflict not found' });
    }
    res.json({ success: true, conflict: result.rows[0] });
  } catch (err) {
    console.error('Error resolving conflict:', err);
    res.status(500).json({ success: false, error: 'Failed to resolve conflict' });
  }
});

// ==============================
// POST /timetable-import/jobs/:jobId/approve — approve + trigger booking generation
// ==============================
router.post('/jobs/:jobId/approve', protect, adminOnly, async (req, res) => {
  const { jobId } = req.params;

  try {
    const jobCheck = await pool.query('SELECT status FROM timetable_import_jobs WHERE id = $1', [jobId]);
    if (!jobCheck.rows.length) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    if (jobCheck.rows[0].status !== 'REVIEW_REQUIRED') {
      return res
        .status(409)
        .json({ success: false, error: 'Job must be in REVIEW_REQUIRED status to approve' });
    }

    const unresolvedErrors = await pool.query(
      `SELECT COUNT(*) FROM timetable_import_conflicts
       WHERE job_id = $1 AND severity = 'ERROR' AND resolved = FALSE`,
      [jobId]
    );
    if (parseInt(unresolvedErrors.rows[0].count) > 0) {
      return res.status(409).json({
        success: false,
        error: 'Cannot approve — unresolved error conflicts exist. Resolve all errors first.',
      });
    }

    await pool.query(
      `UPDATE timetable_extracted_lectures
       SET status = 'APPROVED', reviewed_by = $1, reviewed_at = NOW()
       WHERE job_id = $2 AND status = 'PENDING'`,
      [req.user.id, jobId]
    );

    await pool.query(`UPDATE timetable_import_jobs SET status = 'APPROVED', updated_at = NOW() WHERE id = $1`, [
      jobId,
    ]);

    await enqueueBookingGeneration(jobId);

    res.json({ success: true, message: 'Import approved — booking generation started' });
  } catch (err) {
    console.error('Error approving import job:', err);
    res.status(500).json({ success: false, error: 'Failed to approve import job' });
  }
});

export default router;
