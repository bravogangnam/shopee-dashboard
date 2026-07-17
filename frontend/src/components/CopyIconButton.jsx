import { useEffect, useRef, useState } from 'react';

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';

  document.body.appendChild(textarea);
  textarea.select();

  const copied = document.execCommand('copy');
  textarea.remove();

  if (!copied) {
    throw new Error('Fallback copy failed');
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      fallbackCopyText(text);
      return;
    }
  }

  fallbackCopyText(text);
}

export default function CopyIconButton({
  value,
  label = '값',
  className = '',
  onCopied,
  onCopyError,
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  const text = String(value ?? '').trim();
  const disabled = !text;

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    if (disabled) return;

    try {
      await writeClipboard(text);

      setCopied(true);
      onCopied?.(text);

      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }

      timerRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 1200);
    } catch (error) {
      setCopied(false);
      onCopyError?.(error, text);
    }
  };

  const title = copied ? `${label} 복사 완료` : `${label} 복사`;

  return (
    <button
      type="button"
      className={`copy-icon-button${copied ? ' is-copied' : ''}${className ? ` ${className}` : ''}`}
      onClick={handleCopy}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5 12.5 9.2 17 19 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M8 8V5.8A1.8 1.8 0 0 1 9.8 4h8.4A1.8 1.8 0 0 1 20 5.8v8.4a1.8 1.8 0 0 1-1.8 1.8H16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect
            x="4"
            y="8"
            width="12"
            height="12"
            rx="1.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          />
        </svg>
      )}
    </button>
  );
}
