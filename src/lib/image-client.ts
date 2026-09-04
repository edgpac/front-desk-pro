// Client-side image compression before sending to the estimate server
// function — ported from Cabos Handyman's SecureAIAssistant.tsx, which
// resizes to a max dimension and re-compresses if still too large.

export type CompressedImage = { base64: string; mediaType: string };

const MAX_DIMENSION = 1280;
const TARGET_QUALITY = 0.8;

function compressBlob(source: HTMLImageElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    let { width, height } = source;

    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      if (width > height) {
        height = Math.round((height * MAX_DIMENSION) / width);
        width = MAX_DIMENSION;
      } else {
        width = Math.round((width * MAX_DIMENSION) / height);
        height = MAX_DIMENSION;
      }
    }

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Canvas not supported"));
      return;
    }
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);

    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Compression failed"))),
      "image/jpeg",
      TARGET_QUALITY,
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split("base64,")[1];
      if (!base64) {
        reject(new Error("Unexpected file reader result"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(blob);
  });
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

/** Compress a user-uploaded file before sending it to the server. */
export async function fileToCompressedBase64(file: File): Promise<CompressedImage> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const blob = await compressBlob(img);
    const base64 = await blobToBase64(blob);
    return { base64, mediaType: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Compress a same-origin bundled asset (e.g. one of the demo sample photos). */
export async function urlToCompressedBase64(url: string): Promise<CompressedImage> {
  const img = await loadImage(url);
  const blob = await compressBlob(img);
  const base64 = await blobToBase64(blob);
  return { base64, mediaType: "image/jpeg" };
}
