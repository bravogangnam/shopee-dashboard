export default function ImagePreviewModal({ item, onClose }) {
  if (!item) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content image-preview-modal" onClick={event => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">
          ✕
        </button>
        <img
          src={item.image_url}
          alt={item.item_name || ''}
          style={{ maxWidth: '400px', maxHeight: '400px' }}
        />
        <p>{item.item_name || '-'}</p>
        <p>{item.model_name || '-'}</p>
      </div>
    </div>
  );
}
