/* Video hướng dẫn dùng chung cho trang chủ và /app.
   Admin dán link YouTube, TikTok, Google Drive hoặc file .mp4 trong trang quản trị. File này đổi link đó thành khung nhúng. */
(function (root) {
    var YT = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
    var TT = /tiktok\.com\/(?:@[\w.-]+\/video|embed(?:\/v2)?|v)\/(\d{8,25})/;
    var DRIVE = /drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/;
    var FILE = /^https:\/\/[^\s"'<>]+\.(?:mp4|webm)(?:\?[^\s"'<>]*)?$/i;

    function embed(url) {
        var link = String(url || '').trim();
        if (!/^https:\/\//i.test(link)) return null;
        var m = link.match(YT);
        if (m) return { kind: 'frame', src: 'https://www.youtube-nocookie.com/embed/' + m[1] + '?rel=0', tall: /\/shorts\//.test(link) };
        m = link.match(TT);
        if (m) return { kind: 'frame', src: 'https://www.tiktok.com/embed/v2/' + m[1], tall: true };
        m = link.match(DRIVE);
        if (m) return { kind: 'frame', src: 'https://drive.google.com/file/d/' + m[1] + '/preview', tall: false };
        if (FILE.test(link)) return { kind: 'video', src: link, tall: false };
        return null;
    }

    var cache = null;
    function load() {
        if (cache) return cache;
        cache = fetch('/api/exams?only=guide', { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                var list = data && data.guide && Array.isArray(data.guide.videos) ? data.guide.videos : [];
                return list.filter(function (v) { return v && embed(v.url); }).slice(0, 8);
            })
            .catch(function () { return []; });
        return cache;
    }

    /* Dựng khung xem bằng DOM thuần để trang chủ không cần React. */
    function mount(box, video) {
        var info = embed(video && video.url);
        box.innerHTML = '';
        if (!info) return false;
        var el;
        if (info.kind === 'video') {
            el = document.createElement('video');
            el.controls = true;
            el.preload = 'metadata';
            el.playsInline = true;
            el.src = info.src;
        } else {
            el = document.createElement('iframe');
            el.src = info.src;
            el.title = (video && video.title) || 'Video hướng dẫn FPass';
            el.loading = 'lazy';
            el.allow = 'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen';
            el.allowFullscreen = true;
            el.referrerPolicy = 'strict-origin-when-cross-origin';
        }
        el.className = 'guide-media' + (info.tall ? ' is-tall' : '');
        box.appendChild(el);
        return true;
    }

    root.FPassGuide = { embed: embed, load: load, mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);
