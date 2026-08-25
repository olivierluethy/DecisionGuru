import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { NoteTarget } from '@decisionguru/shared';
import { fmtDate } from '../lib/format';

export function NotesPanel({ target, targetId }: { target: NoteTarget; targetId: number | null }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const key = ['notes', target, targetId];
  const { data: notes } = useQuery({ queryKey: key, queryFn: () => api.listNotes(target, targetId) });

  const add = useMutation({
    mutationFn: () => api.addNote(target, targetId, draft.trim()),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: key });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteNote(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return (
    <div>
      <div className="flex gap-2 mb-3">
        <textarea
          className="input !h-auto py-2 resize-none flex-1"
          rows={2}
          placeholder="Add a note — your thesis, a reminder, why you're holding…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="btn-primary self-end"
          disabled={!draft.trim() || add.isPending}
          onClick={() => add.mutate()}
        >
          Add
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {(notes ?? []).map((n) => (
          <div key={n.id} className="group flex items-start justify-between gap-3 bg-surface-2 rounded p-3 text-sm">
            <div>
              <p className="whitespace-pre-wrap text-text">{n.body}</p>
              <span className="text-[11px] text-text-faint">{fmtDate(n.updatedAt)}</span>
            </div>
            <button
              className="text-text-faint hover:text-loss opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => remove.mutate(n.id)}
              aria-label="Delete note"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {!notes?.length && <p className="text-sm text-text-faint">No notes yet.</p>}
      </div>
    </div>
  );
}
