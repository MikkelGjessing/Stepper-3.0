(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const key = params.get('key');

  /**
   * Display the image at the given src.
   * Default size: 75 % of natural dimensions, scaled down to fit the viewport.
   */
  function displayImage(src, alt) {
    const img = document.getElementById('viewerImg');
    if (!img) return;

    img.alt = alt || '';
    img.src = src;

    img.onload = function () {
      const nW = img.naturalWidth;
      const nH = img.naturalHeight;
      if (!nW || !nH) return;

      // Target: 75 % of natural size
      let targetW = nW * 0.75;
      let targetH = nH * 0.75;

      // Constrain to viewport (leave room for close button + padding)
      const maxW = window.innerWidth - 40;
      const maxH = window.innerHeight - 100;
      if (targetW > maxW || targetH > maxH) {
        const scale = Math.min(maxW / targetW, maxH / targetH);
        targetW = Math.round(targetW * scale);
        targetH = Math.round(targetH * scale);
      }

      img.style.width = targetW + 'px';
      img.style.height = targetH + 'px';
    };
  }

  // Retrieve image data from session storage and display it
  if (key) {
    chrome.storage.session.get([key], function (data) {
      if (data && data[key]) {
        const item = data[key];
        document.title = item.alt ? 'Image: ' + item.alt : 'Image Viewer';
        displayImage(item.src, item.alt);
        // Clean up storage entry after use
        chrome.storage.session.remove([key]);
      }
    });
  }

  // Close on ESC key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      window.close();
    }
  });

  // Close button
  const closeBtn = document.getElementById('viewerClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      window.close();
    });
  }
})();
