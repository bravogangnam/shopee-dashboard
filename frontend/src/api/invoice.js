import { getStoredToken } from './client.js';

function authHeaders() {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatInvoiceError(message) {
  const text = typeof message === 'string' ? message : JSON.stringify(message || '');
  if (
    /Shipping parameters can only be obtained when package is ready to be shipped/i.test(text) ||
    /buyer TW KYC/i.test(text) ||
    /\bKYC\b/i.test(text) ||
    /package is ready to be shipped/i.test(text)
  ) {
    return '대만 KYC 승인 대기 또는 송장 준비 전 주문입니다. 구매자 인증/배송 준비 완료 후 다시 시도하세요.';
  }
  if (/PDF|file|파일|not found|not ready/i.test(text)) {
    return '송장 PDF가 아직 준비되지 않았습니다. 잠시 후 주문 동기화 후 다시 시도하세요.';
  }
  return text || '송장 출력에 실패했습니다.';
}

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(formatInvoiceError(payload.error || payload.message || payload.detail || `Request failed: ${response.status}`));
  }
  return payload;
}

export async function startInvoice(orderSnList) {
  const response = await fetch('/api/invoice/start', {
    method: 'POST',
    credentials: 'include',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ order_sn_list: orderSnList }),
  });

  return parseJsonResponse(response);
}

export async function getInvoiceJobStatus(jobId) {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/status`, {
    credentials: 'include',
    headers: authHeaders(),
  });

  return parseJsonResponse(response);
}

export async function downloadInvoice(jobId) {
  const response = await fetch(`/api/invoice/download/${encodeURIComponent(jobId)}`, {
    credentials: 'include',
    headers: authHeaders(),
  });

  if (!response.ok) {
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      const payload = await response.json().catch(() => ({}));
      const message = [payload.error, payload.detail].filter(Boolean).join(' ');
      throw new Error(formatInvoiceError(message || `Download failed: ${response.status}`));
    }
    const message = await response.text().catch(() => '');
    throw new Error(formatInvoiceError(message || `Download failed: ${response.status}`));
  }

  return response.blob();
}

export function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);

  // Best-effort print prompt. Browser policies may block it after async polling.
  try {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '-9999px';
    iframe.style.left = '-9999px';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.src = url;
    document.body.appendChild(iframe);

    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch (error) {
        console.warn('Print dialog failed, opening PDF in new tab', error);
        window.open(url, '_blank');
      }

      setTimeout(() => {
        try {
          if (iframe.parentNode) {
            iframe.parentNode.removeChild(iframe);
          }
        } catch (error) {
          console.warn('Failed to remove print iframe', error);
        }
        window.URL.revokeObjectURL(url);
      }, 60000);
    };
  } catch (error) {
    console.warn('Print iframe failed, opening PDF in new tab', error);
    window.open(url, '_blank');
    setTimeout(() => window.URL.revokeObjectURL(url), 60000);
  }
}

export async function pollInvoiceJob(jobId) {
  const startedAt = Date.now();
  const timeoutMs = 60 * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    const result = await getInvoiceJobStatus(jobId);
    const job = result.job || result.data || result;
    const status = String(job.status || '').toLowerCase();

    if (status === 'completed') return job;
    if (status === 'failed') {
      throw new Error(formatInvoiceError(job.error_message || job.error || job.message || '송장 생성에 실패했습니다.'));
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('송장 생성 시간이 초과되었습니다.');
}

export async function createAndDownloadInvoice(orderSnList) {
  const startResult = await startInvoice(orderSnList);
  const jobId = startResult.job_id || startResult.jobId;
  if (!jobId) throw new Error('송장 작업 ID를 받지 못했습니다.');

  await pollInvoiceJob(jobId);
  const blob = await downloadInvoice(jobId);
  const suffix = orderSnList.length === 1 ? orderSnList[0] : `${orderSnList.length}-orders`;
  downloadBlob(blob, `invoice-${suffix}.pdf`);

  return startResult;
}
