import DOMPurify from 'dompurify';

export function mailDocument(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: false, FORBID_TAGS: ['style', 'link', 'form', 'input', 'button', 'video', 'audio', 'source', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset', 'background', 'ping'],
  });
  const document = new DOMParser().parseFromString(clean, 'text/html');
  for (const image of document.querySelectorAll('img')) {
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(image.getAttribute('src') ?? '')) {
      image.removeAttribute('src'); image.alt = image.alt || '已屏蔽远程图片';
    }
  }
  for (const link of document.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{font:15px/1.7 system-ui,sans-serif;color:#27352f;overflow-wrap:anywhere;margin:0;padding:12px 4px}img{max-width:100%;height:auto}table{max-width:100%}a{color:#176c54}pre{white-space:pre-wrap}</style></head><body>${document.body.innerHTML}</body></html>`;
}
