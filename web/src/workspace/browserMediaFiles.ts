const databaseName = "videoflow-browser-media-v1";
const storeName = "files";
const urls = new Map<string, string>();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveBrowserMediaFile(mediaId: string, file: Blob) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(file, mediaId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    const old = urls.get(mediaId);
    if (old) URL.revokeObjectURL(old);
    urls.delete(mediaId);
  } finally {
    database.close();
  }
}

export async function copyBrowserMediaFile(sourceMediaId: string, targetMediaId: string) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.get(sourceMediaId);
      request.onsuccess = () => {
        if (!request.result) {
          transaction.abort();
          reject(new Error("原片段的媒体文件缺失，无法完成复制。"));
          return;
        }
        store.put(request.result, targetMediaId);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function browserMediaFileUrl(mediaId: string): Promise<string | null> {
  const cached = urls.get(mediaId);
  if (cached) return cached;
  const database = await openDatabase();
  try {
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).get(mediaId);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urls.set(mediaId, url);
    return url;
  } finally {
    database.close();
  }
}
