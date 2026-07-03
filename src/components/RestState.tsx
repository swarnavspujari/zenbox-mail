// Empty inbox / empty split rest state: a calm daily Unsplash photo behind
// the inbox-zero copy, with the guideline-required attribution. The photo is
// hotlinked (blur-hash placeholder while it loads) and falls back to the
// 24h byte cache offline; showing it fires the download event exactly once.
import { useEffect, useRef, useState } from "react";
import { backend, openExternal } from "@/lib/ipc";
import { decodeBlurHash } from "@/lib/blurhash";
import type { DailyPhoto } from "@/lib/types";

const UNSPLASH_HOME =
  "https://unsplash.com/?utm_source=fission_mail&utm_medium=referral";

function BlurCanvas({ hash }: { hash: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const pixels = decodeBlurHash(hash, 32, 20);
    const ctx = ref.current?.getContext("2d");
    if (!pixels || !ctx) return;
    ctx.putImageData(
      new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, 32, 20),
      0,
      0
    );
  }, [hash]);
  return (
    <canvas
      ref={ref}
      width={32}
      height={20}
      aria-hidden
      className="absolute inset-0 h-full w-full"
    />
  );
}

export function RestState({
  headline,
  sub,
}: {
  headline: string;
  sub?: React.ReactNode;
}) {
  const [photo, setPhoto] = useState<DailyPhoto | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [hotlinkFailed, setHotlinkFailed] = useState(false);

  useEffect(() => {
    let stale = false;
    backend
      .getDailyPhoto()
      .then((p) => {
        if (!stale) setPhoto(p);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  const src =
    photo && hotlinkFailed ? (photo.cachedDataUri ?? photo.url) : photo?.url;

  return (
    <div className="relative h-full w-full overflow-hidden">
      {photo?.blurHash && !imgLoaded && <BlurCanvas hash={photo.blurHash} />}
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={() => {
            setImgLoaded(true);
            // Unsplash guideline: count the download when first shown
            void backend.photoShown().catch(() => {});
          }}
          onError={() => setHotlinkFailed(true)}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
            imgLoaded ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
      {/* protection gradient so the copy reads on any photo (same pattern
          as the inbox-zero celebration) */}
      {photo && (
        <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/25 to-black/45" />
      )}
      <div className="relative flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        {!photo && <div className="text-4xl text-ink-3">◎</div>}
        <div
          className={`text-[17px] font-semibold tracking-tight ${
            photo ? "text-white/90 drop-shadow" : "text-ink-2"
          }`}
        >
          {headline}
        </div>
        {sub && (
          <div
            className={`text-[12.5px] ${
              photo ? "text-white/75 drop-shadow" : "text-ink-3"
            }`}
          >
            {sub}
          </div>
        )}
      </div>
      {photo && (
        <div className="absolute bottom-2.5 right-3.5 text-[11px] text-white/70">
          {photo.authorLink ? (
            <>
              Photo by{" "}
              <button
                className="underline decoration-white/40 hover:text-white"
                onClick={() => void openExternal(photo.authorLink!)}
              >
                {photo.authorName}
              </button>{" "}
              on{" "}
              <button
                className="underline decoration-white/40 hover:text-white"
                onClick={() => void openExternal(UNSPLASH_HOME)}
              >
                Unsplash
              </button>
            </>
          ) : (
            <>{photo.authorName}</>
          )}
        </div>
      )}
    </div>
  );
}
