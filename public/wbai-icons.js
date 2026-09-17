(() => {
  const paths = {
    sparkles: '<path d="m12 3-1.4 5.6L5 10l5.6 1.4L12 17l1.4-5.6L19 10l-5.6-1.4L12 3Z"/><path d="m19 15-.7 2.3L16 18l2.3.7L19 21l.7-2.3L22 18l-2.3-.7L19 15Z"/>',
    zap: '<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="m19 5 2-2"/>',
    plug: '<path d="M9 7v5a3 3 0 0 0 6 0V7"/><path d="M10 3v4M14 3v4M12 15v6"/>',
    shield: '<path d="M12 3 5 6v5c0 5 3.4 8.2 7 10 3.6-1.8 7-5 7-10V6l-7-3Z"/><path d="m9.5 12 1.7 1.7 3.5-3.5"/>',
    box: '<path d="m4 7 8-4 8 4v10l-8 4-8-4V7Z"/><path d="m4 7 8 4 8-4M12 11v10"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18h1.2a1.8 1.8 0 0 0 0-3.6h-1.1a1.4 1.4 0 0 1 0-2.8H14a7 7 0 0 0 7-7c0-2.8-3.5-4.6-9-4.6Z"/><path d="M7.5 10h.01M9.5 6.8h.01M14.5 6.8h.01M17.2 10h.01"/>',
    eye: '<path d="M2.5 12s3.2-5 9.5-5 9.5 5 9.5 5-3.2 5-9.5 5-9.5-5-9.5-5Z"/><circle cx="12" cy="12" r="2.3"/>',
    bell: '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    home: '<path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9Z"/>',
    chart: '<path d="M4 19V5M4 19h17"/><path d="m7 15 4-4 3 2 5-6"/>',
    'credit-card': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>',
    play: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3V9Z"/>',
    clipboard: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2M9 11h6M9 15h4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.8 1.8 0 0 0 .4 2l.1.1-2.2 2.2-.1-.1a1.8 1.8 0 0 0-2-.4 1.8 1.8 0 0 0-1.1 1.6v.2h-3v-.2a1.8 1.8 0 0 0-1.1-1.6 1.8 1.8 0 0 0-2 .4l-.1.1-2.2-2.2.1-.1a1.8 1.8 0 0 0 .4-2 1.8 1.8 0 0 0-1.6-1.1h-.2v-3h.2A1.8 1.8 0 0 0 6.5 9a1.8 1.8 0 0 0-.4-2L6 6.9l2.2-2.2.1.1a1.8 1.8 0 0 0 2 .4 1.8 1.8 0 0 0 1.1-1.6v-.2h3v.2A1.8 1.8 0 0 0 15.5 5a1.8 1.8 0 0 0 2-.4l.1-.1 2.2 2.2-.1.1a1.8 1.8 0 0 0-.4 2 1.8 1.8 0 0 0 1.6 1.1h.2v3h-.2a1.8 1.8 0 0 0-1.5 1.1Z"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m3 17 5-5 3.5 3.5 2.5-2.5 4.5 4.5"/>',
    download: '<path d="M12 3v11M8 10l4 4 4-4M5 21h14"/>',
    message: '<path d="M20 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4v8Z"/><path d="M7 9h8M7 13h5"/>',
    users: '<path d="M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20"/><circle cx="10" cy="8" r="3"/><path d="M17 11a3 3 0 1 0-1.4-5.6M20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-1.5A4.5 4.5 0 0 1 9.5 15h5a4.5 4.5 0 0 1 4.5 4.5V21"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.2 2.5 3.3 5.5 3.3 9S14.2 18.5 12 21c-2.2-2.5-3.3-5.5-3.3-9S9.8 5.5 12 3Z"/>',
    'log-out': '<path d="M10 17l5-5-5-5M15 12H3"/><path d="M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/>',
    wrench: '<path d="M14.5 6.5a4 4 0 0 0-5.2 5.2L3.5 17.5a2 2 0 1 0 3 3l5.8-5.8a4 4 0 0 0 5.2-5.2l-2.6 2.1-2.4-2.4 2-2.7Z"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    camera: '<path d="M4 8h3l1.4-2h7.2L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="14" r="3.5"/>',
    rotate: '<path d="M20 11a8 8 0 1 0 1 4"/><path d="M20 4v7h-7"/>',
    upload: '<path d="M12 17V3M7 8l5-5 5 5M4 21h16"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    book: '<path d="M4 5a3 3 0 0 1 3-3h12v17H7a3 3 0 0 0-3 3V5Z"/><path d="M7 2v17"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.6L3 9M4 13a8 8 0 0 0 14.6 4.6L21 15"/><path d="M3 4v5h5M21 20v-5h-5"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    check: '<path d="m5 12 4.2 4.2L19 6.5"/>',
    'x-circle': '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
    layers: '<path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z"/><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5"/>',
    paperclip: '<path d="m20.5 11.5-8.8 8.8a5 5 0 0 1-7.1-7.1l9-9a3.5 3.5 0 1 1 5 5l-9.1 9.1a2 2 0 0 1-2.8-2.8l8.4-8.4"/>',
    'file-text': '<path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    ruler: '<path d="m3 17 14-14 4 4L7 21 3 17Z"/><path d="m13 7 4 4M10 10l2 2M7 13l2 2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    'light-bulb': '<path d="M9 18h6M10 22h4"/><path d="M8.3 15.3A6 6 0 1 1 15.7 15.3c-.8.6-1.2 1.4-1.2 2.2h-5c0-.8-.4-1.6-1.2-2.2Z"/>',
    save: '<path d="M5 3h12l3 3v15H4V4a1 1 0 0 1 1-1Z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    heart: '<path d="M20.8 8.6c0 5.2-8.8 10.4-8.8 10.4S3.2 13.8 3.2 8.6A4.4 4.4 0 0 1 11 5.8L12 7l1-1.2a4.4 4.4 0 0 1 7.8 2.8Z"/>',
  };
  function injectIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((node) => {
      const path = paths[node.dataset.icon];
      if (!path || node.querySelector('svg')) return;
      node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">${path}</svg>`;
    });
  }
  window.wbaiInjectIcons = injectIcons;
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', injectIcons) : injectIcons();
})();
