import type { PDFDocumentProxy } from 'pdfjs-dist';

type PdfJsModule = typeof import('pdfjs-dist');

let cachedPdfJs: Promise<PdfJsModule> | null = null;

export async function getPdfJs(): Promise<PdfJsModule> {
  if (cachedPdfJs) return cachedPdfJs;
  cachedPdfJs = (async () => {
    const pdfjs = await import('pdfjs-dist');
    const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default as string;
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    return pdfjs;
  })();
  return cachedPdfJs;
}

export async function loadPdfDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfJs();
  try {
    return await pdfjs.getDocument({ data }).promise;
  } catch (err) {
    console.warn('PDF worker failed; retrying without worker.', err);
    return await pdfjs.getDocument({ data, disableWorker: true } as any).promise;
  }
}

