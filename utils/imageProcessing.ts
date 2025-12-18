import JSZip from 'jszip';
import FileSaver from 'file-saver';
import { GridSettings, ImageInfo } from '../types';

/**
 * loads an image from a source string into an HTMLImageElement
 */
export const loadImage = (src: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
};

/**
 * Calculates the dimensions of the "Viewport" (The final output area)
 */
export const getViewportDimensions = (
  imgWidth: number,
  imgHeight: number,
  cropMode: string
) => {
  if (cropMode === 'square') {
    const minDim = Math.min(imgWidth, imgHeight);
    return { width: minDim, height: minDim };
  }
  return { width: imgWidth, height: imgHeight };
};

export const processAndDownload = async (
  imageInfo: ImageInfo,
  settings: GridSettings,
  selectedIndices: Set<number>,
  onProgress: (percent: number) => void
) => {
  const { src, originalName } = imageInfo;
  const { rows, cols, format, cropMode, scaleX, scaleY, offsetX, offsetY, paddingTop, paddingRight, paddingBottom, paddingLeft, filePrefix } = settings;

  try {
    const img = await loadImage(src);
    const zip = new JSZip();

    // 获取设备像素比，用于高分辨率渲染（通常为 1-3，Retina 显示器为 2）
    // 使用 2 倍分辨率来确保高清晰度输出
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    // 1. Determine Viewport Dimensions (The total size of the grid)
    const viewport = getViewportDimensions(img.width, img.height, cropMode);

    // 2. Create a high-resolution canvas representing the Viewport
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { 
      willReadFrequently: false,
      alpha: format === 'png' || format === 'webp' // 保持透明度支持
    });
    if (!ctx) throw new Error("Could not create canvas context");

    // 使用高分辨率：实际尺寸 × 像素比
    const canvasWidth = viewport.width * pixelRatio;
    const canvasHeight = viewport.height * pixelRatio;
    
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // 使用图像平滑算法提升质量
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 3. Draw the image onto the viewport with transformations (使用高分辨率坐标)
    // Clear background
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Calculate draw dimensions based on independent scales (转换为高分辨率)
    const drawWidth = img.width * scaleX * pixelRatio;
    const drawHeight = img.height * scaleY * pixelRatio;

    // Calculate centering offsets base (转换为高分辨率)
    // In both modes, we initially center the image in the viewport
    const baseX = (canvasWidth - drawWidth) / 2;
    const baseY = (canvasHeight - drawHeight) / 2;

    // Apply user pan offsets (converted from percentage to pixels, 转换为高分辨率)
    const finalX = baseX + (offsetX * canvasWidth);
    const finalY = baseY + (offsetY * canvasHeight);

    // Draw the processed image to the master canvas (使用高分辨率尺寸)
    ctx.drawImage(img, finalX, finalY, drawWidth, drawHeight);

    // 4. Slice Generation with Padding
    const sliceWidth = viewport.width / cols;
    const sliceHeight = viewport.height / rows;

    const totalSlices = rows * cols;
    const slicesToExport = selectedIndices.size > 0
      ? Array.from(selectedIndices)
      : Array.from({ length: totalSlices }, (_, i) => i);

    let processedCount = 0;

    const sliceCanvas = document.createElement('canvas');
    const sliceCtx = sliceCanvas.getContext('2d', {
      willReadFrequently: false,
      alpha: format === 'png' || format === 'webp'
    });
    if (!sliceCtx) throw new Error("Ctx error");

    // 计算实际输出尺寸（考虑 padding，转换为高分辨率）
    const outputWidth = Math.max(1, Math.floor((sliceWidth - paddingLeft - paddingRight) * pixelRatio));
    const outputHeight = Math.max(1, Math.floor((sliceHeight - paddingTop - paddingBottom) * pixelRatio));

    // 切片 canvas 使用高分辨率
    sliceCanvas.width = outputWidth;
    sliceCanvas.height = outputHeight;
    sliceCtx.imageSmoothingEnabled = true;
    sliceCtx.imageSmoothingQuality = 'high';

    for (const index of slicesToExport) {
      const row = Math.floor(index / cols);
      const col = index % cols;

      sliceCtx.clearRect(0, 0, outputWidth, outputHeight);

      // Calculate source coordinates with padding offset (转换为高分辨率坐标)
      const srcX = (col * sliceWidth + paddingLeft) * pixelRatio;
      const srcY = (row * sliceHeight + paddingTop) * pixelRatio;
      const srcWidth = (sliceWidth - paddingLeft - paddingRight) * pixelRatio;
      const srcHeight = (sliceHeight - paddingTop - paddingBottom) * pixelRatio;

      // 从高分辨率主 canvas 绘制到高分辨率切片 canvas
      sliceCtx.drawImage(
        canvas,
        srcX, srcY, srcWidth, srcHeight,  // Source (高分辨率坐标)
        0, 0, outputWidth, outputHeight    // Dest (高分辨率尺寸)
      );

      const blob = await new Promise<Blob | null>((resolve) => {
        const mimeType = format === 'jpg' ? 'image/jpeg' : `image/${format}`;
        
        // 根据格式设置质量参数
        // PNG: 不需要质量参数（无损）
        // JPEG: 使用 0.98 高质量（0-1，1 为最高质量）
        // WebP: 使用 0.98 高质量
        if (format === 'png') {
          sliceCanvas.toBlob(resolve, mimeType);
        } else {
          // JPEG 和 WebP 使用高质量参数
          sliceCanvas.toBlob(resolve, mimeType, 0.98);
        }
      });

      if (blob) {
        const ext = format === 'jpg' ? 'jpg' : format;
        const baseName = filePrefix || originalName.substring(0, originalName.lastIndexOf('.')) || 'sliced';
        const filename = `${baseName}_${row + 1}_${col + 1}.${ext}`;
        zip.file(filename, blob);
      }

      processedCount++;
      onProgress(Math.round((processedCount / slicesToExport.length) * 50));
    }

    onProgress(60);
    const content = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        onProgress(60 + Math.round(metadata.percent * 0.4));
    });

    onProgress(100);
    const baseNameForZip = filePrefix || originalName.substring(0, originalName.lastIndexOf('.')) || 'sliced';
    const zipName = `${baseNameForZip}_grid.zip`;

    const saveAs = (FileSaver as any).saveAs || FileSaver;
    saveAs(content, zipName);

  } catch (error) {
    console.error("Slice generation failed", error);
    throw error;
  }
};