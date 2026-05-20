const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database('jobs.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer TEXT NOT NULL,
    vehicle TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  res.json(jobs);
});

app.post('/api/jobs', (req, res) => {
  const { customer, vehicle, description } = req.body;
  if (!customer || !vehicle || !description) {
    return res.status(400).json({ error: 'customer, vehicle, and description are required' });
  }
  const result = db.prepare(
    'INSERT INTO jobs (customer, vehicle, description) VALUES (?, ?, ?)'
  ).run(customer, vehicle, description);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(job);
});

app.put('/api/jobs/:id', (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'in-progress', 'complete'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'status must be pending, in-progress, or complete' });
  }
  const result = db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Job not found' });
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  res.json(job);
});

app.delete('/api/jobs/:id', (req, res) => {
  const result = db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Job not found' });
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Brakeknights server running on port ${PORT}`);
});
