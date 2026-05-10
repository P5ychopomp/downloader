import { http_get } from "../http.ts";
import { NetworkError, ParseError } from "../errors.ts";
import type { MediaItem, MediaResult, ResolveOptions } from "../types.ts";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SHORTCODE_REGEX =
  /(?:pfbid[\w]+|\d+)/;

function traverse<T = unknown>(
  obj: unknown,
  path: (string | number | ((key: string | number, val: unknown) => boolean))[],
  fallback?: T,
): T {
  let current: unknown = obj;
  for (const segment of path) {
    if (current == null) return fallback as T;
    if (typeof segment === "function") {
      if (typeof current !== "object") return fallback as T;
      const entries = Array.isArray(current)
        ? current.entries()
        : Object.entries(current as Record<string, unknown>);
      let found = false;
      for (const [k, v] of entries) {
        if (segment(k, v)) {
          current = v;
          found = true;
          break;
        }
      }
      if (!found) return fallback as T;
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return fallback as T;
    }
  }
  return (current === undefined ? fallback : current) as T;
}

function get_first<T = unknown>(
  obj: unknown,
  paths: (string | number | ((key: string | number, val: unknown) => boolean))[],
  fallback?: T,
): T {
  for (const p of paths) {
    const result = traverse(obj, [p]);
    if (result !== undefined) return result as T;
  }
  return fallback as T;
}

function int_or_none(val: unknown): number | undefined {
  if (val == null) return undefined;
  if (typeof val === "number") return val;
  const n = Number(val);
  return isNaN(n) ? undefined : Math.floor(n);
}

function float_or_none(val: unknown): number | undefined {
  if (val == null) return undefined;
  if (typeof val === "number") return val;
  const n = Number(val);
  return isNaN(n) ? undefined : n;
}

function parse_count(val: unknown): number | undefined {
  if (val == null) return undefined;
  if (typeof val === "number") return val;
  const cleaned = String(val).replace(/,/g, "");
  return int_or_none(cleaned);
}

function url_or_none(val: unknown): string | undefined {
  if (typeof val === "string" && val.length > 0) return val;
  return undefined;
}

function decode_unicode(text: string): string {
  try {
    return text
      .replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\?\//g, "/");
  } catch {
    return text;
  }
}

function extract_text(text: string, start: string, end: string): string {
  const start_idx = text.indexOf(start);
  if (start_idx === -1) return "";
  const from = start_idx + start.length;
  const end_idx = text.indexOf(end, from);
  if (end_idx === -1) return "";
  return text.slice(from, end_idx);
}

function parse_json_safe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface VideoEntry {
  id?: string;
  title?: string;
  description?: string;
  author?: string;
  author_id?: string;
  thumbnail?: string;
  timestamp?: number;
  duration?: number;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  playable_url?: string;
  playable_url_hd?: string;
}

function parse_graphql_video(
  video: Record<string, unknown>,
  video_id: string,
): VideoEntry | null {
  const v_id = (video.videoId as string) || (video.id as string) || video_id;

  const creation_story = video.creation_story as Record<string, unknown> | undefined;
  const short_form = traverse<Record<string, unknown>>(video, [
    "creation_story",
    "short_form_video_context",
    "playback_video",
  ]);

  let owner: Record<string, unknown> = {};
  let playable_video = video;

  if (short_form) {
    playable_video = (creation_story as Record<string, unknown>) || video;
    const vo = short_form.video_owner as Record<string, unknown> | undefined;
    if (vo) owner = vo;
  } else if (creation_story) {
    owner = get_first<Record<string, unknown>>(video, [
      "short_form_video_context",
      "video_owner",
    ], {});
  }

  const playable_url = url_or_none(
    traverse(video, ["playable_url"]) ||
    traverse(short_form, ["playable_url"]) ||
    traverse(video, ["browser_native_sd_url"]) ||
    traverse(video, ["browser_native_hd_url"]),
  );
  const playable_url_hd = url_or_none(
    traverse(video, ["playable_url_quality_hd"]) ||
    traverse(short_form, ["playable_url_quality_hd"]) ||
    traverse(video, ["browser_native_hd_url"]),
  );

  if (!playable_url && !playable_url_hd) return null;

  const quality = traverse<Record<string, unknown>>(video, ["videoDeliveryResponseFragment", "videoDeliveryResponseResult"]);
  const progressive_urls = traverse<Array<{progressive_url?: string; metadata?: {quality?: string}}>>(quality, ["progressive_urls"]);
  const all_urls: Array<{ url: string; quality: string }> = [];

  if (playable_url) all_urls.push({ url: playable_url, quality: "sd" });
  if (playable_url_hd) all_urls.push({ url: playable_url_hd, quality: "hd" });

  if (progressive_urls) {
    for (const pf of progressive_urls) {
      if (pf.progressive_url) {
        all_urls.push({
          url: pf.progressive_url,
          quality: (pf.metadata?.quality as string) || "sd",
        });
      }
    }
  }

  const dash_mpd_urls = traverse<Array<{manifest_url?: string}>>(quality, [
    "dash_manifest_urls",
    () => true,
    "manifest_url",
  ]);
  const dash_manifests = traverse<Array<{manifest_xml?: string}>>(quality, [
    "dash_manifests",
    (key) => key === "manifest_xml",
  ]);

  const hls_urls = traverse<Array<{hls_playlist_url?: string}>>(quality, [
    "hls_playlist_urls",
    () => true,
    "hls_playlist_url",
  ]);

  const video_owner_name = get_first<string>(owner, ["name"]);
  const timestamp = int_or_none(video.publish_time ?? video.creation_time);
  const description = get_first<string>(
    (video.savable_description as Record<string, unknown> | undefined),
    ["text"],
  );
  const title = (video.name as string) || description || `Facebook video #${v_id}`;
  const thumbnail = url_or_none(
    traverse(video, ["thumbnailImage", "uri"]) ||
    traverse(video, ["preferred_thumbnail", "image", "uri"]),
  );

  return {
    id: v_id,
    title,
    description,
    author: video_owner_name || get_first<string>(owner, ["name"]),
    author_id: get_first<string>(owner, ["id"]),
    thumbnail,
    timestamp,
    duration: (() => {
      const durationMs = float_or_none(video.playable_duration_in_ms as number);
      if (durationMs != null) return durationMs / 1000;
      return float_or_none(video.length_in_second as number);
    })(),
    views: int_or_none(video.view_count),
    likes: int_or_none(video.like_count),
    comments: int_or_none(video.comment_count),
    shares: parse_count(video.share_count),
    playable_url: all_urls[0]?.url,
    playable_url_hd: playable_url_hd || all_urls.find((u) => u.quality === "hd")?.url,
  };
}

function parse_sjs_blocks(html: string, video_id: string): VideoEntry | null {
  const sjs_matches = [...html.matchAll(/data-sjs>({.*?})<\/script>/g)];
  const all_data: unknown[] = [];

  for (const match of sjs_matches) {
    const parsed = parse_json_safe(match[1]);
    if (parsed) all_data.push(parsed);
  }

  for (const data of all_data) {
    const instances = traverse<unknown[][]>(data, ["jsmods", "instances"]);
    if (instances) {
      for (const item of instances) {
        if (!Array.isArray(item) || item.length < 3) continue;
        const type_val = item[1];
        if (!Array.isArray(type_val) || type_val.length === 0) continue;
        if (type_val[0] === "VideoConfig") {
          const video_config = item[2];
          if (!Array.isArray(video_config) || !video_config[0]) continue;
          const video_data = video_config[0].videoData;
          if (!Array.isArray(video_data)) continue;
          for (const fmt of video_data) {
            if (!Array.isArray(fmt) || !fmt[0]) continue;
            const best = fmt[0];
            const video_url = (best as Record<string, unknown>).video_url as string;
            if (video_url) {
              const author = decode_unicode(
                extract_text(
                  JSON.stringify(data),
                  '"actors":[{"__typename":"User","name":"',
                  '","',
                ),
              );
              return {
                id: video_id,
                title: "Facebook Video",
                author: author || "Facebook",
                playable_url: video_url,
              };
            }
          }
        }
      }
    }
  }

  for (const data of all_data) {
    const bbox_results = traverse<unknown[]>(data, [
      "require",
      (k) => k !== undefined,
      (k) => k !== undefined,
      (k) => k !== undefined,
      "__bbox",
      "require",
      (k) => k !== undefined,
      (k) => k !== undefined,
      "__bbox",
      "result",
      "data",
    ]);
    if (!Array.isArray(bbox_results)) continue;

    for (const result of bbox_results) {
      if (!result || typeof result !== "object") continue;
      const r = result as Record<string, unknown>;

      const nodes = traverse(r, ["nodes", "node"]);
      if (nodes) {
        traverse(nodes as unknown, [
          ...Array.isArray(nodes)
            ? Array.from({ length: (nodes as unknown[]).length }, (_, i) => i)
            : [],
          "comet_sections",
          "content",
          "story",
          "attachments",
          () => true,
        ]);
      }

      for (const attachment of traverse<unknown[]>(r, [
        () => true,
      ]) || []) {
        const at = attachment as Record<string, unknown>;
        const media = at.media as Record<string, unknown> | undefined;
        if (media?.__typename === "Video") {
          const entry = parse_graphql_video(media as Record<string, unknown>, video_id);
          if (entry) return entry;
        }

        const all_subattachments = at.all_subattachments as { nodes?: unknown[] } | undefined;
        if (all_subattachments?.nodes) {
          for (const node of all_subattachments.nodes) {
            const n = node as Record<string, unknown>;
            const m = n.media as Record<string, unknown> | undefined;
            if (m?.__typename === "Video") {
              const entry = parse_graphql_video(m as Record<string, unknown>, video_id);
              if (entry) return entry;
            }
            const target = n.target as Record<string, unknown> | undefined;
            const target_attachments = target?.attachments as unknown[] | undefined;
            if (target_attachments) {
              for (const ta of target_attachments) {
                const ta_m = (ta as Record<string, unknown>).media as Record<string, unknown> | undefined;
                if (ta_m?.__typename === "Video") {
                  const entry = parse_graphql_video(ta_m as Record<string, unknown>, video_id);
                  if (entry) return entry;
                }
              }
            }
          }
        }
      }

      const video = traverse(r, ["video"]);
      if (video && typeof video === "object") {
        const entry = parse_graphql_video(video as Record<string, unknown>, video_id);
        if (entry) return entry;
      }
    }
  }

  return null;
}

export default async function resolve(
  url: string,
  options: ResolveOptions,
): Promise<MediaResult> {
  try {
    const clean_url = url.replace(/:\/\/m\.facebook\.com\//, "://www.facebook.com/");
    const video_id_match = clean_url.match(SHORTCODE_REGEX);
    if (!video_id_match) {
      throw new ParseError("Could not parse video ID", "facebook");
    }
    const video_id = video_id_match[0];

    const request_options: {
      headers: Record<string, string>;
      timeout?: number;
    } = {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...options.headers,
      },
    };
    if (options.timeout !== undefined) {
      request_options.timeout = options.timeout;
    }

    const response = await http_get(clean_url, request_options);
    const html = await response.text();

    const entry = parse_sjs_blocks(html, video_id);

    const page_title =
      decode_unicode(
        extract_text(html, '<title>', "</title>").trim(),
      ) || "Facebook Video";

    const og_title = decode_unicode(
      extract_text(html, 'property="og:title" content="', '"'),
    );
    const og_desc = decode_unicode(
      extract_text(html, 'property="og:description" content="', '"'),
    );
    const og_image = decode_unicode(
      extract_text(html, 'property="og:image" content="', '"'),
    );
  const og_timestamp = (() => {
    const published = extract_text(html, 'property="article:published_time" content="', '"');
    if (!published) return undefined;
    const parsed = Date.parse(published);
    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
  })();

    const fb_utime = int_or_none(
      extract_text(html, 'data-utime="', '"'),
    );
    const timestamp = fb_utime || og_timestamp;
    const view_count = int_or_none(
      extract_text(html, '"viewCount":"', '"') ||
        extract_text(html, "viewCount\x3A\x22", "\x22"),
    );
    const like_count = int_or_none(
      extract_text(html, '"like_count":"', '"'),
    );
    const comment_count = int_or_none(
      extract_text(html, '"comment_count":"', '"'),
    );

    const urls: MediaItem[] = [];
    const meta: MediaResult["meta"] = {
      platform: "facebook",
      title: og_title || entry?.title || page_title,
      author: entry?.author || "Unknown",
      description: og_desc || entry?.description,
      thumbnail:
        entry?.thumbnail ||
        og_image ||
        decode_unicode(
          extract_text(
            html,
            '"thumbnailImage":{"uri":"',
            '"',
          ).split("?")[0],
        ) ||
        undefined,
      timestamp: entry?.timestamp || timestamp,
      views: entry?.views || view_count,
      likes: entry?.likes || like_count,
      comments: entry?.comments || comment_count,
      shares: entry?.shares,
    };

    if (entry?.playable_url) {
      const ext = entry.playable_url_hd?.includes(".mpd") ? "mpd" : "mp4";
      urls.push({
        type: "video",
        url: entry.playable_url,
        filename: `fb-${video_id}.${ext}`,
      });
    }

    return { urls, headers: { "User-Agent": USER_AGENT }, meta };
  } catch (e: any) {
    if (e instanceof NetworkError || e instanceof ParseError) throw e;
    throw new ParseError(e.message, "facebook");
  }
}
