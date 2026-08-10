import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api.js'

const pdfjsPath = dirname(
  createRequire(import.meta.url).resolve('pdfjs-dist/package.json'),
)

export interface RenderedPdf {
  length: number
  getPage(pageNumber: number): Promise<Buffer>
  destroy(): Promise<void>
}

interface PdfCanvas {
  toBuffer(type: 'image/png'): Buffer
}

interface PdfCanvasFactory {
  create(width: number, height: number): { canvas: PdfCanvas }
}

export async function openPdf(source: Buffer): Promise<RenderedPdf> {
  const loadingTask = pdfjs.getDocument({
    standardFontDataUrl: `${join(pdfjsPath, 'standard_fonts')}${sep}`,
    cMapUrl: `${join(pdfjsPath, 'cmaps')}${sep}`,
    cMapPacked: true,
    isEvalSupported: false,
    data: Uint8Array.from(source),
  } as DocumentInitParameters)
  const document = await loadingTask.promise

  return {
    length: document.numPages,
    async getPage(pageNumber) {
      const page = await document.getPage(pageNumber)
      if (page.destroyed) throw new Error('PDF page is already destroyed')
      const viewport = page.getViewport({ scale: 1 })
      const { canvas } = (
        document.canvasFactory as unknown as PdfCanvasFactory
      ).create(viewport.width, viewport.height)
      await page.render({ canvas: canvas as never, viewport }).promise
      return canvas.toBuffer('image/png')
    },
    async destroy() {
      if (!loadingTask.destroyed) await loadingTask.destroy()
    },
  }
}
