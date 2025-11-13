import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { convertImages } from './api';
import logo from './assets/logo.png';
import './styles.css';

function prettyKB(bytes) {
  const kb = bytes / 1024;
  return `${kb.toFixed(kb > 100 ? 0 : kb > 10 ? 1 : 2)} KB`;
}

const ICONS = {
  pdf: '📄',
  heic: '🖼️',
  gif: '🌀',
  svg: '✒️',
  raw: '🎞️',
  webp: '💠',
  psd: '🖍️',
  ai: '🧠',
  default: '🗂️',
};

function FileCard({ file, preview, dim, onRemove }) {
  const [previewBroken, setPreviewBroken] = useState(false);
  const showPlaceholder = !preview || previewBroken;
  const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  const extLabel = extension ? extension.toUpperCase() : file.type || 'FILE';
  const icon = ICONS[extension] || ICONS.default;

  return (
    <div className="filecard">
      <div className={`thumb ${showPlaceholder ? 'is-placeholder' : ''}`}>
        {showPlaceholder ? (
          <div className="thumb-placeholder">
            <span className="thumb-icon">{icon}</span>
            <span className="thumb-ext">{extLabel}</span>
          </div>
        ) : (
          <img src={preview} alt={file.name} onError={() => setPreviewBroken(true)} />
        )}
      </div>
      <div className="meta">
        <div className="title">{file.name}</div>
        <div className="sub">
          {prettyKB(file.size)}
          {dim ? ` • ${dim.w}×${dim.h}` : ''}
        </div>
      </div>
      <button className="remove" title="Remove" onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}

export default function App() {
  const inputRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlMessage, setUrlMessage] = useState('');
  const [clipboardMessage, setClipboardMessage] = useState('');

  // Options
  const [to, setTo] = useState('webp');
  const [quality, setQuality] = useState(85);
  const [lossless, setLossless] = useState(false);
  const [progressive, setProgressive] = useState(false);
  const [keepMeta, setKeepMeta] = useState(false);
  const [toSRGB, setToSRGB] = useState(false);
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [fit, setFit] = useState(true);
  const [rotateDeg, setRotateDeg] = useState(0);
  const [crop, setCrop] = useState({ x: '', y: '', w: '', h: '' });
  const [bg, setBg] = useState('');
  const [aiMessage, setAiMessage] = useState('Let our assistant pick optimal settings for your assets.');
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = window.localStorage.getItem('image-tool-theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  const [activeNavSection, setActiveNavSection] = useState('workspace');

  const accept = useMemo(() => 'image/*', []);

  const ingestFiles = useCallback(async (fileList) => {
    if (!fileList?.length) return;
    const next = [];
    for (const f of fileList) {
      if (!f) continue;
      const url = URL.createObjectURL(f);
      let previewUrl = url;
      let dim = null;
      try {
        const img = document.createElement('img');
        img.src = url;
        await img.decode();
        dim = { w: img.naturalWidth, h: img.naturalHeight };
      } catch {
        previewUrl = null;
        URL.revokeObjectURL(url);
      }
      next.push({ file: f, preview: previewUrl, dim });
    }
    setFiles((prev) => [...prev, ...next]);
  }, []);

  const onPick = useCallback(async (picked) => {
    await ingestFiles(Array.from(picked));
  }, [ingestFiles]);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      onPick(e.dataTransfer.files);
    },
    [onPick]
  );

  const dropHandlers = {
    onDragOver: (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDrop,
  };

  useEffect(() => {
    document.body.dataset.theme = theme;
    window.localStorage.setItem('image-tool-theme', theme);
  }, [theme]);

  useEffect(() => {
    const handlePaste = (event) => {
      if (!event.clipboardData) return;
      const fileItems = Array.from(event.clipboardData.files || []);
      if (!fileItems.length) return;
      event.preventDefault();
      ingestFiles(fileItems);
      setClipboardMessage('Pasted from clipboard');
      setTimeout(() => setClipboardMessage(''), 2200);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [ingestFiles]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  const applyAiAssist = () => {
    if (!files.length) {
      setAiMessage('Drop some images so I can analyze them for a smart preset.');
      return;
    }
    const heavy = files.some((f) => f.file.size > 2 * 1024 * 1024);
    const large = files.some((f) => f.dim && (f.dim.w >= 2600 || f.dim.h >= 2600));
    const transparentCandidates = files.some((f) => /png|webp|gif/i.test(f.file.type) || /\.png$/i.test(f.file.name));
    const multiType = new Set(files.map((f) => f.file.type)).size > 1;

    const chosenFormat = transparentCandidates && !multiType ? 'png' : 'webp';
    const chosenQuality = chosenFormat === 'png' ? 90 : 82;

    setTo(chosenFormat);
    setQuality(chosenQuality);
    setLossless(chosenFormat === 'png' && files.length === 1);
    setProgressive(chosenFormat === 'jpg');
    setKeepMeta(files.length <= 2);
    setToSRGB(true);
    if (heavy || large) {
      setWidth('2048');
      setHeight('');
    } else {
      setWidth('');
      setHeight('');
    }
    setAiMessage(
      `AI preset: ${chosenFormat.toUpperCase()} • ${
        heavy || large ? '2048px max width' : 'full resolution'
      } • ${chosenQuality}% quality`
    );
  };

  const addSamples = async () => {
    const makeSample = (title, colorA, colorB) =>
      new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 320;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 512, 320);
        gradient.addColorStop(0, colorA);
        gradient.addColorStop(1, colorB);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '48px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(title, canvas.width / 2, canvas.height / 2);
        canvas.toBlob((blob) => {
          if (blob) {
            const file = new File([blob], `${title}.png`, { type: 'image/png' });
            resolve(file);
          } else {
            resolve(null);
          }
        }, 'image/png');
      });

    const sampleFiles = await Promise.all([
      makeSample('Gradient', '#8f8bff', '#72d5ff'),
      makeSample('Palette', '#ff9a8b', '#fad0c4'),
    ]);
    ingestFiles(sampleFiles.filter(Boolean));
  };

  const fetchFromUrl = async () => {
    if (!urlInput.trim()) return;
    setUrlBusy(true);
    setUrlMessage('Fetching image…');
    try {
      const response = await fetch(urlInput.trim());
      if (!response.ok) throw new Error('Unable to fetch that URL.');
      const blob = await response.blob();
      const mime = blob.type || 'application/octet-stream';
      const extension = mime.split('/')[1] || 'download';
      const file = new File([blob], `remote-${Date.now()}.${extension}`, { type: mime });
      await ingestFiles([file]);
      setUrlMessage('Added from URL');
      setUrlInput('');
      setTimeout(() => setUrlMessage(''), 2000);
    } catch (err) {
      setUrlMessage(err.message || 'Failed to fetch image');
    } finally {
      setUrlBusy(false);
    }
  };

  const revokePreview = (entry) => {
    if (entry?.preview) URL.revokeObjectURL(entry.preview);
  };

  const removeAt = (idx) =>
    setFiles((fs) => {
      const target = fs[idx];
      if (target) revokePreview(target);
      return fs.filter((_, i) => i !== idx);
    });

  const clearAll = () => {
    files.forEach(revokePreview);
    setFiles([]);
  };

  async function onConvert() {
    if (!files.length) return;
    setBusy(true);
    try {
      const { blob, filename } = await convertImages({
        files: files.map((f) => f.file),
        to,
        quality: to === 'jpg' || to === 'webp' ? Number(quality) : null,
        lossless,
        progressive,
        keep_metadata: keepMeta,
        to_srgb: toSRGB,
        width: width ? Number(width) : null,
        height: height ? Number(height) : null,
        fit,
        rotate_deg: Number(rotateDeg || 0),
        crop: {
          x: crop.x ? Number(crop.x) : null,
          y: crop.y ? Number(crop.y) : null,
          w: crop.w ? Number(crop.w) : null,
          h: crop.h ? Number(crop.h) : null,
        },
        bg: bg || null,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const renderNavPanelContent = () => {
    switch (activeNavSection) {
      case 'workspace':
        return (
          <>
            <h4>Drop zone</h4>
            <p className="panel-note">Jump directly to the drop area, output options, or queue on the page below.</p>
            <div className="panel-links">
              <a className="panel-link" href="#dropzone">Drop area</a>
              <a className="panel-link" href="#output">Output</a>
              <a className="panel-link" href="#queue">Session queue</a>
            </div>
          </>
        );
      case 'ai':
        return (
          <>
            <h4>AI assistant</h4>
            <p className="panel-note">{aiMessage}</p>
            <button className="btn accent" onClick={applyAiAssist}>
              Let AI tune
            </button>
            <p className="small">Analyzes size, resolution, and transparency clues.</p>
          </>
        );
      case 'transform':
        return (
          <>
            <h4>Transform</h4>
            <label className="label">Width</label>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              placeholder="0 = auto"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
            />
            <label className="label">Height</label>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              placeholder="0 = auto"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
            />
            <label className="checkbox">
              <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} />
              <span>Keep aspect ratio</span>
            </label>
            <label className="label">Rotate deg</label>
            <input className="input" type="number" value={rotateDeg} onChange={(e) => setRotateDeg(Number(e.target.value || 0))} />
          </>
        );
      case 'crop':
        return (
          <>
            <h4>Crop & background</h4>
            <div className="crop-grid">
              <div>
                <label className="label">X</label>
                <input className="input" type="number" value={crop.x} onChange={(e) => setCrop((s) => ({ ...s, x: e.target.value }))} />
              </div>
              <div>
                <label className="label">Y</label>
                <input className="input" type="number" value={crop.y} onChange={(e) => setCrop((s) => ({ ...s, y: e.target.value }))} />
              </div>
              <div>
                <label className="label">W</label>
                <input className="input" type="number" value={crop.w} onChange={(e) => setCrop((s) => ({ ...s, w: e.target.value }))} />
              </div>
              <div>
                <label className="label">H</label>
                <input className="input" type="number" value={crop.h} onChange={(e) => setCrop((s) => ({ ...s, h: e.target.value }))} />
              </div>
            </div>
            <label className="label">Alpha background</label>
            <input className="input" placeholder="#ffffff or css color" value={bg} onChange={(e) => setBg(e.target.value)} />
            <p className="panel-note">Used when converting transparent images to JPG, TIFF, BMP.</p>
          </>
        );
      case 'sources':
      default:
        return (
          <>
            <h4>Input sources</h4>
            <div className="panel-actions">
              <button className="btn accent" onClick={() => inputRef.current?.click()}>
                Browse device
              </button>
              <button className="btn ghost" onClick={() => setClipboardMessage('Use ⌘/Ctrl + V to paste images from your clipboard.')}>
                Paste shortcut
              </button>
              <button className="btn ghost" onClick={addSamples}>
                Add sample pack
              </button>
            </div>
            <div className="url-input compact">
              <input
                className="input"
                placeholder="https://example.com/hero.png"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
              />
              <button className="btn accent" onClick={fetchFromUrl} disabled={urlBusy}>
                {urlBusy ? 'Fetching…' : 'Import'}
              </button>
            </div>
            {(urlMessage || clipboardMessage) && <p className="panel-note">{urlMessage || clipboardMessage}</p>}
          </>
        );
    }
  };

  return (
    <div className={`app-shell theme-${theme}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="ambient ambient-three" />

      <div className="container">
        <nav className="nav card glass">
          <div className="nav-top">
            <div className="brand">
              <div className="brand-logo">
                <img src={logo} alt="Image Converter" />
              </div>
              <div>
                <div className="brand-title">Image Converter</div>
                <p className="brand-sub">Sculpt perfect assets in seconds.</p>
              </div>
            </div>
            <div className="nav-actions">
              <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme" aria-pressed={theme === 'dark'}>
                <span className="theme-toggle-label">{theme === 'dark' ? 'Dark' : 'Light'} mode</span>
                <span className="theme-toggle-track" aria-hidden="true">
                  <span className="theme-icon">☀️</span>
                  <span className="theme-icon">🌙</span>
                  <span className={`theme-thumb ${theme === 'dark' ? 'thumb-dark' : 'thumb-light'}`} />
                </span>
              </button>
              <button className="btn ghost" onClick={() => inputRef.current?.click()}>
                Add images
              </button>
              <input
                ref={inputRef}
                type="file"
                accept={accept}
                multiple
                style={{ display: 'none' }}
                onChange={(e) => onPick(e.target.files)}
              />
              <button className="btn ghost" onClick={clearAll} disabled={!files.length}>
                Reset queue
              </button>
              <button className="btn accent" onClick={onConvert} disabled={!files.length || busy}>
                {busy ? 'Processing…' : 'Download batch'}
              </button>
            </div>
          </div>

          <div className="nav-panel">
            <div className="nav-section-tabs">
              {[
                { key: 'workspace', label: 'Drop zone' },
                { key: 'sources', label: 'Sources' },
                { key: 'ai', label: 'AI assistant' },
                { key: 'transform', label: 'Transform' },
                { key: 'crop', label: 'Crop' },
              ].map((section) => (
                <button
                  key={section.key}
                  className={`nav-section-tab ${activeNavSection === section.key ? 'is-active' : ''}`}
                  onClick={() => setActiveNavSection(section.key)}
                >
                  {section.label}
                </button>
              ))}
            </div>
            <div className="panel-block">{renderNavPanelContent()}</div>
          </div>
        </nav>

        <div className="primary-stack" id="workspace">
          <div {...dropHandlers} className="card drop glass" id="dropzone">
            <div className="drop-illustration">
              <span />
              <span />
              <span />
            </div>
            <h3>Drag & drop images</h3>
            <p>Smart HEIC decoding, transparency safe, and blazing fast batch processing.</p>
            <div className="drop-actions">
              <button className="btn accent" onClick={() => inputRef.current?.click()}>
                Browse files
              </button>
              <p className="small">Drop anything from RAW previews to animated GIFs.</p>
            </div>
          </div>

          <section className="workspace-compact">
            <div className="card control glass" id="output">
              <div className="control-head">
                <h3>Output</h3>
                <p>Pick your delivery format and compression preferences.</p>
              </div>
              <label className="label">Format</label>
              <select className="select" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="webp">WebP</option>
                <option value="jpg">JPG</option>
                <option value="png">PNG</option>
                <option value="tiff">TIFF</option>
                <option value="gif">GIF</option>
                <option value="bmp">BMP</option>
                <option value="pdf">PDF</option>
              </select>

              {(to === 'jpg' || to === 'webp') && (
                <>
                  <label className="label">Quality</label>
                  <input
                    className="input"
                    type="number"
                    min="40"
                    max="100"
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))}
                  />
                </>
              )}

              {to === 'webp' && (
                <label className="checkbox">
                  <input type="checkbox" checked={lossless} onChange={(e) => setLossless(e.target.checked)} />
                  <span>Lossless</span>
                </label>
              )}
              {to === 'jpg' && (
                <label className="checkbox">
                  <input type="checkbox" checked={progressive} onChange={(e) => setProgressive(e.target.checked)} />
                  <span>Progressive</span>
                </label>
              )}
              <label className="checkbox">
                <input type="checkbox" checked={keepMeta} onChange={(e) => setKeepMeta(e.target.checked)} />
                <span>Keep metadata</span>
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={toSRGB} onChange={(e) => setToSRGB(e.target.checked)} />
                <span>Convert to sRGB</span>
              </label>
            </div>

            <div className="card files-panel glass" id="queue">
              <div className="files-header">
                <div>
                  <p className="eyebrow">Session queue</p>
                  <h3>{files.length ? 'Queued assets' : 'Start with a drop'}</h3>
                </div>
                <div className="queue-actions">
                  <span className="pill">{files.length} files</span>
                  <button className="btn ghost" onClick={clearAll} disabled={!files.length}>
                    Clear queue
                  </button>
                  <button className="btn accent" onClick={onConvert} disabled={!files.length || busy}>
                    {busy ? 'Processing…' : 'Download batch'}
                  </button>
                </div>
              </div>
              {files.length ? (
                <div className="file-grid">
                  {files.map((f, i) => (
                    <FileCard key={`${f.file.name}-${i}`} file={f.file} preview={f.preview} dim={f.dim} onRemove={() => removeAt(i)} />
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <h4>No files yet</h4>
                  <p>Queue images to see previews, metadata, and perfect download bundles.</p>
                </div>
              )}
              <div className="small tip">Tip: for transparent PNG → JPG, set an alpha background to avoid harsh edges.</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
