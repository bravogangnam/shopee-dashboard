import { getStoredToken } from './client.js';

function authHeaders() {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Request failed: ${response.status}`);
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
    const message = await response.text().catch(() => '');
    throw new Error(message || `Download failed: ${response.status}`);
  }

  return response.blob();
}

export function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
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
      throw new Error(job.error || job.message || '송장 생성에 실패했습니다.');
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
