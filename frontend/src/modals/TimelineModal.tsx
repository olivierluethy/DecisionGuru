import { useQuery } from '@tanstack/react-query';
import { Modal } from '../components/Modal';
import { AccountTimeline } from '../components/AccountTimeline';
import { Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useApp } from '../store';

/** The account timeline in a large modal — more room to scroll-zoom and pan. */
export function TimelineModal() {
  const { closeModal } = useApp();
  const { data, isLoading } = useQuery({ queryKey: ['timeline'], queryFn: () => api.timeline() });

  return (
    <Modal
      title="Account timeline"
      subtitle={data ? `${data.events.length} events · scroll to zoom · drag to pan` : undefined}
      onClose={closeModal}
      size="xl"
      footer={
        <button className="btn-secondary" onClick={closeModal}>
          Close
        </button>
      }
    >
      {isLoading || !data ? (
        <Spinner label="Loading timeline…" />
      ) : data.events.length ? (
        <AccountTimeline events={data.events} height={440} />
      ) : (
        <p className="text-sm text-text-faint py-6 text-center">No dated events yet.</p>
      )}
    </Modal>
  );
}
