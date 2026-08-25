import { Router } from 'express';
import { listNotes, allNotes, insertNote, updateNote, deleteNote } from '../services/repo.js';

export const notesRouter = Router();

notesRouter.get('/', (req, res) => {
  const target = req.query.target as string | undefined;
  if (!target) return res.json(allNotes());
  const targetId = req.query.targetId != null ? Number(req.query.targetId) : null;
  res.json(listNotes(target, targetId));
});

notesRouter.post('/', (req, res) => {
  const { target, targetId, body } = req.body ?? {};
  if (!target || !body) return res.status(400).json({ error: 'target and body required' });
  res.json(insertNote(target, targetId ?? null, body));
});

notesRouter.patch('/:id', (req, res) => {
  const { body } = req.body ?? {};
  const note = updateNote(Number(req.params.id), body ?? '');
  if (!note) return res.status(404).json({ error: 'Not found' });
  res.json(note);
});

notesRouter.delete('/:id', (req, res) => {
  deleteNote(Number(req.params.id));
  res.json({ ok: true });
});
