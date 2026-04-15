const FALLBACK_CHUNK_BYTES = 5 * 1024 * 1024;
const MIN_CHUNK_BYTES = 64 * 1024;

async function parseJson(response) {
  return response.json().catch(() => ({}));
}

function normalizeUploadedBytes(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function buildUploadError(response, payload) {
  const error = new Error(payload?.error || `HTTP_${response.status}`);
  error.status = response.status;
  error.code = payload?.error || "";
  if (Number.isFinite(payload?.uploadedBytes)) {
    error.uploadedBytes = Number(payload.uploadedBytes);
  }
  if (Number.isFinite(payload?.maxBytes)) {
    error.maxBytes = Number(payload.maxBytes);
  }
  if (Number.isFinite(payload?.chunkSizeBytes)) {
    error.chunkSizeBytes = Number(payload.chunkSizeBytes);
  }
  return error;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await parseJson(response);
  if (!response.ok) {
    throw buildUploadError(response, payload);
  }
  return payload;
}

export async function uploadFileInChunks({
  file,
  initUrl,
  completeUrl,
  abortUrl,
  buildChunkUrl,
  headers,
  initBody,
  onProgress,
  signal,
}) {
  if (!file) return null;

  let session = null;
  try {
    session = await requestJson(initUrl, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify({
        ...initBody,
        fileName: file.name || "upload.bin",
        contentType: file.type || "application/octet-stream",
        sizeBytes: Number(file.size || 0),
      }),
    });

    const totalBytes = Number(file.size || 0);
    let offset = Number(session?.uploadedBytes || 0);
    const chunkSizeBytes = Math.max(
      MIN_CHUNK_BYTES,
      Math.min(
        Number(session?.chunkSizeBytes || FALLBACK_CHUNK_BYTES),
        FALLBACK_CHUNK_BYTES,
      ),
    );

    while (offset < totalBytes) {
      const nextOffset = Math.min(offset + chunkSizeBytes, totalBytes);
      const chunk = file.slice(offset, nextOffset);
      const response = await fetch(buildChunkUrl(session.uploadId, offset), {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/octet-stream",
        },
        signal,
        body: chunk,
      });
      const payload = await parseJson(response);

      if (!response.ok) {
        const uploadedBytes = normalizeUploadedBytes(payload?.uploadedBytes);
        if (response.status === 409 && uploadedBytes !== null) {
          if (uploadedBytes <= offset) {
            throw new Error("UPLOAD_OFFSET_STALE");
          }
          offset = uploadedBytes;
          continue;
        }
        throw buildUploadError(response, payload);
      }

      const uploadedBytes = normalizeUploadedBytes(payload?.uploadedBytes);
      offset = uploadedBytes !== null ? uploadedBytes : nextOffset;
      if (offset < nextOffset) {
        throw new Error("UPLOAD_PROGRESS_STALE");
      }
      if (typeof onProgress === "function") {
        onProgress({
          uploadedBytes: offset,
          totalBytes,
          file,
          session,
        });
      }
    }

    const completed = await requestJson(completeUrl(session.uploadId), {
      method: "POST",
      headers: {
        ...headers,
      },
      signal,
    });
    if (typeof onProgress === "function") {
      onProgress({
        uploadedBytes: totalBytes,
        totalBytes,
        file,
        session,
        complete: true,
      });
    }
    return completed;
  } catch (error) {
    if (session?.uploadId && abortUrl) {
      fetch(abortUrl(session.uploadId), {
        method: "DELETE",
        headers: {
          ...headers,
        },
        signal,
      }).catch(() => {});
    }
    throw error;
  }
}
