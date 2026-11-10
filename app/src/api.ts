/** Thin browser client for the Gate API. The browser never holds simulator tokens or secrets. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

let currentUser = 'analyst-priya';
export const setDemoUser = (u: string) => {
  currentUser = u;
};
export const getDemoUser = () => currentUser;

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-demo-user': currentUser },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: { code: 'BAD_RESPONSE', message: text.slice(0, 200) } };
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } })?.error;
    // CH-20: the visitor session ended; reloading shows the passcode page for this same address.
    if (res.status === 401 && err?.code === 'ACCESS_REQUIRED') window.location.reload();
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed (${res.status})`, json);
  }
  return json as T;
}

/** CH-20: ends the visitor session and returns to the passcode page. */
export async function leaveDemo(): Promise<void> {
  await fetch('/api/access/logout', { method: 'POST' }).catch(() => undefined);
  window.location.reload();
}

export async function upload<T>(path: string, file: File, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams({ ...params, fileName: file.name });
  const res = await fetch(`/api${path}?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-demo-user': currentUser },
    body: file,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } })?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? 'Upload failed', json);
  }
  return json as T;
}
