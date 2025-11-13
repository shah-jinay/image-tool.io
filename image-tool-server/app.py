#!/usr/bin/env python3
import io, zipfile, logging
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from PIL import Image, ImageOps, ImageCms, ImageColor

# ---------- HEIC/HEIF support ----------
try:
    import pillow_heif  # type: ignore
    pillow_heif.register_heif_opener()
except Exception:
    # If missing, HEIC uploads will fail to open; install with: pip install pillow-heif
    pass

app = FastAPI(title="Image Tool Server")

# ---------- CORS (allow any localhost/127.0.0.1 port) ----------
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- constants / helpers ----------
ALLOWED_OUT = {"jpg", "jpeg", "png", "webp", "tiff", "gif", "bmp", "pdf"}


def has_alpha(im: Image.Image) -> bool:
    return "A" in im.getbands()


def normalize_bg(bg: Optional[str]) -> Optional[str]:
    """Validate a CSS-like color string for Pillow. Returns None if invalid/empty."""
    if not bg:
        return None
    try:
        ImageColor.getrgb(bg)  # validates color
        return bg
    except Exception:
        return None


def to_srgb_if_requested(im: Image.Image, to_srgb: bool) -> Image.Image:
    if not to_srgb:
        return im
    try:
        icc = im.info.get("icc_profile")
        if icc:
            src = ImageCms.ImageCmsProfile(bytes(icc))
            dst = ImageCms.createProfile("sRGB")
            out_mode = "RGB" if has_alpha(im) else im.mode
            im = ImageCms.profileToProfile(im, src, dst, outputMode=out_mode)
            if im.mode not in ("RGB", "RGBA", "L"):
                im = im.convert("RGB")
    except Exception as e:
        logging.warning("sRGB conversion skipped: %s", e)
    return im


def apply_exif_orientation(im: Image.Image) -> Image.Image:
    return ImageOps.exif_transpose(im)


def apply_resize_rotate_crop(
    im: Image.Image,
    width: Optional[int],
    height: Optional[int],
    fit: bool,
    rotate_deg: int,
    crop_x: Optional[int],
    crop_y: Optional[int],
    crop_w: Optional[int],
    crop_h: Optional[int],
) -> Image.Image:
    # Crop first
    if all(v is not None for v in [crop_x, crop_y, crop_w, crop_h]) and crop_w > 0 and crop_h > 0:
        x, y, w, h = crop_x, crop_y, crop_w, crop_h
        x = max(0, x)
        y = max(0, y)
        w = max(1, min(im.width - x, w))
        h = max(1, min(im.height - y, h))
        im = im.crop((x, y, x + w, y + h))

    # Rotate (UI is clockwise; PIL is counterclockwise)
    if rotate_deg and rotate_deg % 360 != 0:
        im = im.rotate(-rotate_deg, expand=True, resample=Image.BICUBIC)

    # Resize
    if width or height:
        if width and height:
            if fit:
                im = ImageOps.contain(im, (width, height), Image.LANCZOS)
            else:
                im = im.resize((width, height), Image.LANCZOS)
        elif width and not height:
            r = width / im.width
            im = im.resize((width, max(1, int(im.height * r))), Image.LANCZOS)
        elif height and not width:
            r = height / im.height
            im = im.resize((max(1, int(im.width * r)), height), Image.LANCZOS)

    return im


def ext_for_fmt(fmt: str) -> str:
    fmt = fmt.lower()
    return {
        "jpeg": ".jpg",
        "jpg": ".jpg",
        "png": ".png",
        "webp": ".webp",
        "tiff": ".tiff",
        "bmp": ".bmp",
        "gif": ".gif",
        "pdf": ".pdf",
    }.get(fmt, f".{fmt}")


def encode_image(
    im: Image.Image,
    out_fmt: str,
    keep_metadata: bool,
    quality: Optional[int],
    progressive: bool,
    lossless: bool,
    bg: Optional[str],
) -> io.BytesIO:
    """
    Encode a single image into non-PDF formats (JPG/PNG/WebP/TIFF/GIF/BMP).
    For PDF, we handle multi-page in the route instead of here.
    """
    fmt = out_fmt.lower()
    if fmt == "pdf":
        raise ValueError("encode_image is not used for pdf; handle in route")

    params = {}

    # Quality clamp
    if quality is not None:
        try:
            quality = max(1, min(100, int(quality)))
        except Exception:
            quality = None

    # Alpha + mode fixes for JPEG/BMP/TIFF
    if fmt in {"jpg", "jpeg", "bmp", "tiff"}:
        if has_alpha(im) or im.mode not in ("RGB", "L"):
            safe_bg = normalize_bg(bg) or "white"
            base = Image.new("RGB", im.size, safe_bg)
            if im.mode != "RGBA":
                im = im.convert("RGBA")
            base.paste(im, mask=im.split()[-1])
            im = base
        if fmt in {"jpg", "jpeg"} and im.mode != "RGB":
            im = im.convert("RGB")

    # Palette PNG → RGBA
    if fmt == "png" and im.mode == "P":
        im = im.convert("RGBA")

    # Format params
    if fmt in {"jpg", "jpeg"}:
        params.update(
            dict(
                quality=quality if quality is not None else 85,
                optimize=True,
                progressive=progressive,
                subsampling="4:2:0",
            )
        )
        fmt_out = "JPEG"
    elif fmt == "webp":
        params.update(
            dict(
                quality=quality if quality is not None else 80,
                method=6,
                lossless=lossless,
            )
        )
        fmt_out = "WEBP"
    elif fmt == "tiff":
        params.update(dict(compression="tiff_lzw"))
        fmt_out = "TIFF"
    elif fmt == "png":
        fmt_out = "PNG"
    elif fmt == "gif":
        fmt_out = "GIF"
    elif fmt == "bmp":
        fmt_out = "BMP"
    else:
        fmt_out = fmt.upper()

    icc = im.info.get("icc_profile") if keep_metadata else None
    exif = im.info.get("exif") if keep_metadata else None

    buf = io.BytesIO()

    # Try with metadata, then without, then final fallback
    try:
        im.save(buf, format=fmt_out, icc_profile=icc, exif=exif, **params)
    except Exception as e1:
        logging.warning("Save with metadata failed: %s. Retrying without metadata...", e1)
        buf = io.BytesIO()
        try:
            im.save(buf, format=fmt_out, **params)
        except Exception as e2:
            logging.error("Save without metadata failed: %s. Applying final fallback...", e2)
            if fmt_out == "JPEG" and im.mode != "RGB":
                im = im.convert("RGB")
            buf = io.BytesIO()
            im.save(buf, format=fmt_out, quality=quality if quality else 85)

    buf.seek(0)
    return buf


# ---------- routes ----------
@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/convert")
async def convert(
    files: List[UploadFile] = File(..., description="One or more images"),
    to: str = Form(..., description="Target format: jpg, png, webp, tiff, gif, bmp, pdf"),
    quality: Optional[int] = Form(None),
    lossless: bool = Form(False),
    progressive: bool = Form(False),
    keep_metadata: bool = Form(False),
    to_srgb: bool = Form(False),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    fit: bool = Form(True),
    rotate_deg: int = Form(0),
    crop_x: Optional[int] = Form(None),
    crop_y: Optional[int] = Form(None),
    crop_w: Optional[int] = Form(None),
    crop_h: Optional[int] = Form(None),
    bg: Optional[str] = Form(None),
):
    out_fmt = to.lower()
    if out_fmt not in ALLOWED_OUT:
        return JSONResponse(status_code=400, content={"error": f"Unsupported output format: {to}"})

    bg = normalize_bg(bg)
    errors: list[str] = []

    # ---------- Special case: PDF, combine into one multi-page PDF ----------
    if out_fmt == "pdf":
        pdf_images: list[Image.Image] = []

        for f in files:
            try:
                data = await f.read()
                im = Image.open(io.BytesIO(data))
                im.load()
                im = apply_exif_orientation(im)
                im = to_srgb_if_requested(im, to_srgb)
                im = apply_resize_rotate_crop(im, width, height, fit, rotate_deg, crop_x, crop_y, crop_w, crop_h)

                # Flatten alpha for PDF if needed
                if has_alpha(im) or im.mode not in ("RGB", "L"):
                    safe_bg = bg or "white"
                    base = Image.new("RGB", im.size, safe_bg)
                    if im.mode != "RGBA":
                        im = im.convert("RGBA")
                    base.paste(im, mask=im.split()[-1])
                    im = base

                if im.mode not in ("RGB", "L"):
                    im = im.convert("RGB")

                pdf_images.append(im)
            except Exception as e:
                logging.exception("Failed processing %s for PDF", f.filename)
                errors.append(f"{f.filename}: {e.__class__.__name__}: {e}")

        if not pdf_images:
            return JSONResponse(status_code=400, content={"error": "All files failed", "details": errors})

        buf = io.BytesIO()
        first, *rest = pdf_images
        first.save(buf, format="PDF", save_all=True, append_images=rest)
        buf.seek(0)

        # Name PDF from first file if available
        try:
            first_name = files[0].filename.rsplit(".", 1)[0]
        except Exception:
            first_name = "images"
        filename = f"{first_name}.pdf"

        return StreamingResponse(
            buf,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # ---------- Normal image formats ----------
    outputs: list[tuple[str, io.BytesIO]] = []

    for f in files:
        try:
            data = await f.read()
            im = Image.open(io.BytesIO(data))
            im.load()
            im = apply_exif_orientation(im)
            im = to_srgb_if_requested(im, to_srgb)
            im = apply_resize_rotate_crop(im, width, height, fit, rotate_deg, crop_x, crop_y, crop_w, crop_h)

            outbuf = encode_image(im, out_fmt, keep_metadata, quality, progressive, lossless, bg)
            outname = f.filename.rsplit(".", 1)[0] + ext_for_fmt(out_fmt)
            outputs.append((outname, outbuf))
        except Exception as e:
            logging.exception("Failed processing %s", f.filename)
            errors.append(f"{f.filename}: {e.__class__.__name__}: {e}")

    if not outputs:
        return JSONResponse(status_code=400, content={"error": "All files failed", "details": errors})

    if len(outputs) == 1 and not errors:
        name, buf = outputs[0]
        return StreamingResponse(
            buf,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )

    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, buf in outputs:
            zf.writestr(name, buf.getvalue())
        if errors:
            zf.writestr("errors.txt", "\n".join(errors))
    zip_buf.seek(0)
    return StreamingResponse(
        zip_buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="converted_images.zip"'},
    )
