import { createCanvas, loadImage } from 'canvas';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';

export async function generatePng({ outputDir, data, filename }) {
  await fs.mkdir(outputDir, { recursive: true });

  const safeName = filename
    ? (filename.endsWith('.png') ? filename : `${filename}.png`)
    : `imagen-${nanoid(8)}.png`;

  const width = data.width ?? 800;
  const height = data.height ?? 500;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = data.bgColor ?? '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  switch (data.type) {
    case 'chart':
      drawChart(ctx, data, width, height);
      break;
    case 'table':
      drawTable(ctx, data, width, height);
      break;
    case 'text':
      drawTextImage(ctx, data, width, height);
      break;
    case 'diagram':
      drawDiagram(ctx, data, width, height);
      break;
    default:
      ctx.fillStyle = '#999999';
      ctx.font = '16px Arial';
      ctx.fillText('Tipo de imagen no reconocido', 20, 40);
  }

  const buffer = canvas.toBuffer('image/png');
  const filePath = path.join(outputDir, safeName);
  await fs.writeFile(filePath, buffer);

  return { filePath, filename: safeName };
}

function drawChart(ctx, data, w, h) {
  const chartType = data.chartType ?? 'bar';
  const padding = { top: 60, right: 40, bottom: 60, left: 60 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 20px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(data.title ?? '', w / 2, 35);

  const labels = data.labels ?? [];
  const datasets = data.datasets ?? [];
  if (!labels.length || !datasets.length) return;

  const maxVal = Math.max(...datasets.flatMap((ds) => ds.data ?? []), 1);
  const colors = ['#0D95A1', '#E891A0', '#0FA38F', '#C4704B', '#475569', '#067A85'];

  if (chartType === 'bar') {
    const barGroupWidth = chartW / labels.length;
    const barWidth = Math.min(barGroupWidth * 0.6 / datasets.length, 50);
    const groupPadding = (barGroupWidth - barWidth * datasets.length) / 2;

    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, h - padding.bottom);
    ctx.lineTo(w - padding.right, h - padding.bottom);
    ctx.stroke();

    datasets.forEach((ds, dsIdx) => {
      ctx.fillStyle = ds.color ?? colors[dsIdx % colors.length];
      (ds.data ?? []).forEach((val, i) => {
        const barH = (val / maxVal) * chartH;
        const x = padding.left + i * barGroupWidth + groupPadding + dsIdx * barWidth;
        const y = h - padding.bottom - barH;
        ctx.fillRect(x, y, barWidth - 2, barH);
      });
    });

    ctx.fillStyle = '#475569';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    labels.forEach((label, i) => {
      const x = padding.left + i * barGroupWidth + barGroupWidth / 2;
      ctx.fillText(label, x, h - padding.bottom + 20);
    });
  } else if (chartType === 'pie' || chartType === 'doughnut') {
    const total = datasets[0]?.data?.reduce((a, b) => a + b, 0) ?? 1;
    const cx = w / 2;
    const cy = h / 2 + 10;
    const radius = Math.min(chartW, chartH) / 2 - 20;
    const innerRadius = chartType === 'doughnut' ? radius * 0.5 : 0;
    let startAngle = -Math.PI / 2;

    (datasets[0]?.data ?? []).forEach((val, i) => {
      const sliceAngle = (val / total) * Math.PI * 2;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.moveTo(cx + innerRadius * Math.cos(startAngle), cy + innerRadius * Math.sin(startAngle));
      ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
      ctx.arc(cx, cy, innerRadius, startAngle + sliceAngle, startAngle, true);
      ctx.closePath();
      ctx.fill();

      const midAngle = startAngle + sliceAngle / 2;
      const labelR = radius + 25;
      ctx.fillStyle = '#0F172A';
      ctx.font = '12px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(
        `${labels[i] ?? ''} (${val})`,
        cx + labelR * Math.cos(midAngle),
        cy + labelR * Math.sin(midAngle)
      );

      startAngle += sliceAngle;
    });
  } else if (chartType === 'line') {
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, h - padding.bottom);
    ctx.lineTo(w - padding.right, h - padding.bottom);
    ctx.stroke();

    for (let i = 0; i <= 5; i++) {
      const y = padding.top + (chartH / 5) * i;
      ctx.strokeStyle = '#F1F5F9';
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
    }

    datasets.forEach((ds, dsIdx) => {
      ctx.strokeStyle = ds.color ?? colors[dsIdx % colors.length];
      ctx.lineWidth = 2.5;
      ctx.beginPath();

      const stepX = chartW / Math.max(labels.length - 1, 1);
      (ds.data ?? []).forEach((val, i) => {
        const x = padding.left + i * stepX;
        const y = h - padding.bottom - (val / maxVal) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      (ds.data ?? []).forEach((val, i) => {
        const x = padding.left + i * stepX;
        const y = h - padding.bottom - (val / maxVal) * chartH;
        ctx.fillStyle = ds.color ?? colors[dsIdx % colors.length];
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    ctx.fillStyle = '#475569';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    labels.forEach((label, i) => {
      const x = padding.left + (chartW / Math.max(labels.length - 1, 1)) * i;
      ctx.fillText(label, x, h - padding.bottom + 20);
    });
  }
}

function drawTable(ctx, data, w, h) {
  const headers = data.headers ?? [];
  const rows = data.rows ?? [];
  const allRows = [headers, ...rows];
  const rowHeight = 36;
  const startY = data.title ? 50 : 20;

  if (data.title) {
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(data.title, w / 2, 35);
  }

  const colCount = headers.length || 1;
  const colWidth = (w - 40) / colCount;

  allRows.forEach((row, rowIdx) => {
    const y = startY + rowIdx * rowHeight;
    const isHeader = rowIdx === 0;

    ctx.fillStyle = isHeader ? '#0D95A1' : (rowIdx % 2 === 0 ? '#F8FBFC' : '#FFFFFF');
    ctx.fillRect(20, y, w - 40, rowHeight);

    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(20, y + rowHeight);
    ctx.lineTo(w - 20, y + rowHeight);
    ctx.stroke();

    ctx.fillStyle = isHeader ? '#FFFFFF' : '#0F172A';
    ctx.font = isHeader ? 'bold 13px Arial' : '12px Arial';
    ctx.textAlign = 'left';

    row.forEach((cell, colIdx) => {
      ctx.fillText(String(cell ?? ''), 28 + colIdx * colWidth, y + rowHeight / 2 + 5);
    });
  });
}

function drawTextImage(ctx, data, w, h) {
  const accent = data.accentColor ?? '#0D95A1';

  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, w, 6);

  if (data.title) {
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(data.title, w / 2, 60);
  }

  if (data.subtitle) {
    ctx.fillStyle = '#475569';
    ctx.font = '18px Arial';
    ctx.fillText(data.subtitle, w / 2, 95);
  }

  if (data.body) {
    ctx.fillStyle = '#1E293B';
    ctx.font = '14px Arial';
    ctx.textAlign = 'left';

    const maxWidth = w - 80;
    const words = data.body.split(' ');
    let line = '';
    let y = data.subtitle ? 140 : 100;

    words.forEach((word) => {
      const testLine = line + word + ' ';
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && line) {
        ctx.fillText(line, 40, y);
        line = word + ' ';
        y += 22;
      } else {
        line = testLine;
      }
    });
    if (line) ctx.fillText(line, 40, y);
  }
}

function drawDiagram(ctx, data, w, h) {
  const accent = data.accentColor ?? '#0D95A1';

  if (data.title) {
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(data.title, w / 2, 35);
  }

  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];

  ctx.strokeStyle = '#94A3B8';
  ctx.lineWidth = 2;
  edges.forEach((edge) => {
    const fromNode = nodes.find((n) => n.id === edge.from);
    const toNode = nodes.find((n) => n.id === edge.to);
    if (!fromNode || !toNode) return;

    ctx.beginPath();
    ctx.moveTo(fromNode.x, fromNode.y);
    ctx.lineTo(toNode.x, toNode.y);
    ctx.stroke();

    const angle = Math.atan2(toNode.y - fromNode.y, toNode.x - fromNode.x);
    const arrowLen = 10;
    const endX = toNode.x - 40 * Math.cos(angle);
    const endY = toNode.y - 40 * Math.sin(angle);
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - arrowLen * Math.cos(angle - 0.4), endY - arrowLen * Math.sin(angle - 0.4));
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - arrowLen * Math.cos(angle + 0.4), endY - arrowLen * Math.sin(angle + 0.4));
    ctx.stroke();

    if (edge.label) {
      const midX = (fromNode.x + toNode.x) / 2;
      const midY = (fromNode.y + toNode.y) / 2 - 8;
      ctx.fillStyle = '#475569';
      ctx.font = '11px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(edge.label, midX, midY);
    }
  });

  nodes.forEach((node) => {
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(node.x, node.y, 30, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#067A85';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.label ?? node.id, node.x, node.y);
    ctx.textBaseline = 'alphabetic';
  });
}

export async function editPng({ inputPath, outputDir, changes, filename }) {
  await fs.mkdir(outputDir, { recursive: true });

  const safeName = filename
    ? (filename.endsWith('.png') ? filename : `${filename}.png`)
    : `editada-${nanoid(8)}.png`;

  let pipeline = sharp(inputPath);

  if (changes.resize) {
    pipeline = pipeline.resize(changes.resize.width, changes.resize.height, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  if (changes.crop) {
    pipeline = pipeline.extract({
      left: changes.crop.x,
      top: changes.crop.y,
      width: changes.crop.width,
      height: changes.crop.height,
    });
  }

  if (changes.rotate) {
    pipeline = pipeline.rotate(changes.rotate);
  }

  if (changes.brightness !== undefined || changes.contrast !== undefined) {
    pipeline = pipeline.modulate({
      brightness: changes.brightness ? 1 + changes.brightness : undefined,
    });
    if (changes.contrast !== undefined) {
      pipeline = pipeline.linear(
        1 + changes.contrast,
        -(128 * changes.contrast)
      );
    }
  }

  if (changes.grayscale) {
    pipeline = pipeline.grayscale();
  }

  if (changes.blur) {
    pipeline = pipeline.blur(changes.blur);
  }

  if (changes.sharpen) {
    pipeline = pipeline.sharpen();
  }

  if (changes.addText?.length || changes.watermark) {
    const metadata = await sharp(inputPath).metadata();
    const imgW = changes.resize?.width ?? metadata.width ?? 800;
    const imgH = changes.resize?.height ?? metadata.height ?? 600;

    const processedBuffer = await pipeline.png().toBuffer();

    const canvas = createCanvas(imgW, imgH);
    const ctx = canvas.getContext('2d');
    const img = await loadImage(processedBuffer);
    ctx.drawImage(img, 0, 0, imgW, imgH);

    for (const textItem of changes.addText ?? []) {
      ctx.fillStyle = textItem.color ?? '#0F172A';
      ctx.font = `${textItem.fontSize ?? 16}px ${textItem.font ?? 'Arial'}`;
      ctx.textAlign = 'left';
      ctx.fillText(textItem.text ?? '', textItem.x ?? 20, textItem.y ?? 40);
    }

    if (changes.watermark) {
      const wm = changes.watermark;
      ctx.globalAlpha = wm.opacity ?? 0.3;
      ctx.fillStyle = wm.color ?? '#999999';
      ctx.font = `${wm.fontSize ?? 24}px ${wm.font ?? 'Arial'}`;
      ctx.textAlign = 'center';
      ctx.translate(imgW / 2, imgH / 2);
      ctx.rotate(-0.4);
      ctx.fillText(wm.text ?? '', 0, 0);
      ctx.rotate(0.4);
      ctx.translate(-imgW / 2, -imgH / 2);
      ctx.globalAlpha = 1;
    }

    const finalBuffer = canvas.toBuffer('image/png');
    const filePath = path.join(outputDir, safeName);
    await fs.writeFile(filePath, finalBuffer);
    return { filePath, filename: safeName };
  }

  const filePath = path.join(outputDir, safeName);
  await pipeline.png().toFile(filePath);

  return { filePath, filename: safeName };
}
