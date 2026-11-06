/**
 * 在 B 站页面主世界执行（由 service worker 通过 chrome.scripting 注入）。
 * 必须自包含：不能引用本文件以外的函数，否则注入后会找不到。
 *
 * 流程：view 接口拿 cid / 简介 → WBI 签名请求 player/wbi/v2 拿字幕地址 → 下载字幕 JSON。
 * 未登录时字幕列表为空，这是接口限制，不是签名错误。
 *
 * @param {string} bvid
 * @param {string} aid 纯数字 av 号，没有 bvid 时使用
 * @param {number} page 分 P 序号，从 1 开始
 * @returns {Promise<object>}
 */
async function fetchBilibiliContentInPage(bvid, aid, page) {
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
  ];
  const LAN_PREFER = ["zh-CN", "zh-Hans", "ai-zh", "zh", "zh-HK", "zh-TW", "zh-Hant", "ai-en", "en-US", "en"];

  function md5(input) {
    function add(x, y) {
      const lsw = (x & 0xffff) + (y & 0xffff);
      return (((x >> 16) + (y >> 16) + (lsw >> 16)) << 16) | (lsw & 0xffff);
    }
    function rol(x, n) {
      return (x << n) | (x >>> (32 - n));
    }
    function cmn(q, a, b, x, s, t) {
      return add(rol(add(add(a, q), add(x, t)), s), b);
    }
    function ff(a, b, c, d, x, s, t) {
      return cmn((b & c) | (~b & d), a, b, x, s, t);
    }
    function gg(a, b, c, d, x, s, t) {
      return cmn((b & d) | (c & ~d), a, b, x, s, t);
    }
    function hh(a, b, c, d, x, s, t) {
      return cmn(b ^ c ^ d, a, b, x, s, t);
    }
    function ii(a, b, c, d, x, s, t) {
      return cmn(c ^ (b | ~d), a, b, x, s, t);
    }

    const bytes = unescape(encodeURIComponent(input));
    const len = bytes.length;
    const words = [];
    for (let i = 0; i < len; i += 1) words[i >> 2] |= bytes.charCodeAt(i) << ((i % 4) * 8);
    words[len >> 2] |= 0x80 << ((len % 4) * 8);
    words[(((len + 8) >>> 6) << 4) + 14] = len * 8;

    let a = 1732584193;
    let b = -271733879;
    let c = -1732584194;
    let d = 271733878;

    for (let i = 0; i < words.length; i += 16) {
      const oa = a;
      const ob = b;
      const oc = c;
      const od = d;
      a = ff(a, b, c, d, words[i + 0], 7, -680876936);
      d = ff(d, a, b, c, words[i + 1], 12, -389564586);
      c = ff(c, d, a, b, words[i + 2], 17, 606105819);
      b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
      a = ff(a, b, c, d, words[i + 4], 7, -176418897);
      d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
      c = ff(c, d, a, b, words[i + 6], 17, -1473231341);
      b = ff(b, c, d, a, words[i + 7], 22, -45705983);
      a = ff(a, b, c, d, words[i + 8], 7, 1770035416);
      d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
      c = ff(c, d, a, b, words[i + 10], 17, -42063);
      b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
      a = ff(a, b, c, d, words[i + 12], 7, 1804603682);
      d = ff(d, a, b, c, words[i + 13], 12, -40341101);
      c = ff(c, d, a, b, words[i + 14], 17, -1502002290);
      b = ff(b, c, d, a, words[i + 15], 22, 1236535329);
      a = gg(a, b, c, d, words[i + 1], 5, -165796510);
      d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
      c = gg(c, d, a, b, words[i + 11], 14, 643717713);
      b = gg(b, c, d, a, words[i + 0], 20, -373897302);
      a = gg(a, b, c, d, words[i + 5], 5, -701558691);
      d = gg(d, a, b, c, words[i + 10], 9, 38016083);
      c = gg(c, d, a, b, words[i + 15], 14, -660478335);
      b = gg(b, c, d, a, words[i + 4], 20, -405537848);
      a = gg(a, b, c, d, words[i + 9], 5, 568446438);
      d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
      c = gg(c, d, a, b, words[i + 3], 14, -187363961);
      b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
      a = gg(a, b, c, d, words[i + 13], 5, -1444681467);
      d = gg(d, a, b, c, words[i + 2], 9, -51403784);
      c = gg(c, d, a, b, words[i + 7], 14, 1735328473);
      b = gg(b, c, d, a, words[i + 12], 20, -1926607734);
      a = hh(a, b, c, d, words[i + 5], 4, -378558);
      d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
      c = hh(c, d, a, b, words[i + 11], 16, 1839030562);
      b = hh(b, c, d, a, words[i + 14], 23, -35309556);
      a = hh(a, b, c, d, words[i + 1], 4, -1530992060);
      d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
      c = hh(c, d, a, b, words[i + 7], 16, -155497632);
      b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
      a = hh(a, b, c, d, words[i + 13], 4, 681279174);
      d = hh(d, a, b, c, words[i + 0], 11, -358537222);
      c = hh(c, d, a, b, words[i + 3], 16, -722521979);
      b = hh(b, c, d, a, words[i + 6], 23, 76029189);
      a = hh(a, b, c, d, words[i + 9], 4, -640364487);
      d = hh(d, a, b, c, words[i + 12], 11, -421815835);
      c = hh(c, d, a, b, words[i + 15], 16, 530742520);
      b = hh(b, c, d, a, words[i + 2], 23, -995338651);
      a = ii(a, b, c, d, words[i + 0], 6, -198630844);
      d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
      c = ii(c, d, a, b, words[i + 14], 15, -1416354905);
      b = ii(b, c, d, a, words[i + 5], 21, -57434055);
      a = ii(a, b, c, d, words[i + 12], 6, 1700485571);
      d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
      c = ii(c, d, a, b, words[i + 10], 15, -1051523);
      b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
      a = ii(a, b, c, d, words[i + 8], 6, 1873313359);
      d = ii(d, a, b, c, words[i + 15], 10, -30611744);
      c = ii(c, d, a, b, words[i + 6], 15, -1560198380);
      b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
      a = ii(a, b, c, d, words[i + 4], 6, -145523070);
      d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
      c = ii(c, d, a, b, words[i + 2], 15, 718787259);
      b = ii(b, c, d, a, words[i + 9], 21, -343485551);
      a = add(a, oa);
      b = add(b, ob);
      c = add(c, oc);
      d = add(d, od);
    }

    function hex(n) {
      let s = "";
      for (let i = 0; i < 4; i += 1) s += ((n >> (i * 8 + 4)) & 0xf).toString(16) + ((n >> (i * 8)) & 0xf).toString(16);
      return s;
    }
    return hex(a) + hex(b) + hex(c) + hex(d);
  }

  function mixinKey(imgKey, subKey) {
    const raw = imgKey + subKey;
    let mixed = "";
    for (let i = 0; i < MIXIN_KEY_ENC_TAB.length; i += 1) mixed += raw[MIXIN_KEY_ENC_TAB[i]] || "";
    return mixed.slice(0, 32);
  }

  function keyFromUrl(url) {
    const slash = url.lastIndexOf("/");
    const dot = url.lastIndexOf(".");
    return url.slice(slash + 1, dot);
  }

  function encWbi(params, imgKey, subKey) {
    const signed = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
    const query = Object.keys(signed)
      .sort()
      .map((key) => {
        const value = String(signed[key]).replace(/[!'()*]/g, "");
        return encodeURIComponent(key) + "=" + encodeURIComponent(value);
      })
      .join("&");
    return query + "&w_rid=" + md5(query + mixinKey(imgKey, subKey));
  }

  async function getJson(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error("请求失败 " + response.status);
    return response.json();
  }

  function absUrl(url) {
    if (!url) return "";
    if (url.startsWith("//")) return "https:" + url;
    return url;
  }

  function pickTrack(list) {
    const usable = (list || []).filter((item) => item && item.subtitle_url);
    for (let i = 0; i < LAN_PREFER.length; i += 1) {
      const found = usable.find((item) => item.lan === LAN_PREFER[i]);
      if (found) return found;
    }
    return usable[0] || null;
  }

  function usableDesc(desc) {
    const text = (desc || "").trim();
    if (!text || text === "-" || text === "null") return "";
    return text;
  }

  if (!bvid && !aid) {
    return { ok: false, error: "无法识别当前视频的 BV 号或 AV 号" };
  }

  const viewUrl = bvid
    ? "https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bvid)
    : "https://api.bilibili.com/x/web-interface/view?aid=" + encodeURIComponent(aid);

  let view;
  try {
    view = await getJson(viewUrl);
  } catch (err) {
    return { ok: false, error: "读取视频信息失败：" + (err.message || "网络错误") };
  }
  if (!view || view.code !== 0 || !view.data) {
    return { ok: false, error: "读取视频信息失败：" + ((view && view.message) || "未知错误") };
  }

  const data = view.data;
  const pageNo = Number(page) || 1;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const part = pages.find((item) => item.page === pageNo) || pages[pageNo - 1] || null;
  const cid = (part && part.cid) || data.cid;
  const videoTitle = (part && part.part && pages.length > 1 ? data.title + " " + part.part : data.title) || "B 站视频";
  const desc = usableDesc(data.desc);
  const viewSubtitleList = (data.subtitle && data.subtitle.list) || [];

  if (!cid) {
    return { ok: false, error: "没有拿到视频分 P 信息，暂时读不了字幕" };
  }

  let nav;
  try {
    nav = await getJson("https://api.bilibili.com/x/web-interface/nav");
  } catch (err) {
    return { ok: false, error: "读取字幕签名失败：" + (err.message || "网络错误") };
  }
  const wbi = nav && nav.data && nav.data.wbi_img;
  if (!wbi || !wbi.img_url || !wbi.sub_url) {
    return { ok: false, error: "读取字幕签名失败" };
  }

  const playerParams = { cid: cid };
  if (bvid) playerParams.bvid = bvid;
  else playerParams.aid = aid;

  let player;
  try {
    const query = encWbi(playerParams, keyFromUrl(wbi.img_url), keyFromUrl(wbi.sub_url));
    player = await getJson("https://api.bilibili.com/x/player/wbi/v2?" + query);
  } catch (err) {
    return { ok: false, error: "读取字幕列表失败：" + (err.message || "网络错误") };
  }
  if (!player || player.code !== 0) {
    return { ok: false, error: "读取字幕列表失败：" + ((player && player.message) || "未知错误") };
  }

  const playerData = player.data || {};
  const track = pickTrack(playerData.subtitle && playerData.subtitle.subtitles);
  if (!track) {
    const locked = playerData.need_login_subtitle || viewSubtitleList.length > 0;
    if (locked) {
      return { ok: false, error: "这个视频有字幕，但需要登录 B 站才能读取。请先登录后再点分析。" };
    }
    if (desc) {
      return {
        ok: true,
        source: "desc",
        videoTitle: videoTitle,
        videoText: "标题：" + videoTitle + "\n简介：" + desc,
      };
    }
    return { ok: false, error: "这个视频没有可用字幕，也没有简介。" };
  }

  const subtitleUrl = absUrl(track.subtitle_url);
  try {
    const subtitle = await getJson(subtitleUrl);
    const body = (subtitle && subtitle.body) || [];
    const lines = [];
    for (let i = 0; i < body.length; i += 1) {
      const content = ((body[i] && body[i].content) || "").trim();
      if (!content || content === lines[lines.length - 1]) continue;
      lines.push(content);
    }
    if (!lines.length) {
      return { ok: false, error: "字幕文件是空的" };
    }
    return {
      ok: true,
      source: "subtitle",
      videoTitle: videoTitle,
      lanDoc: track.lan_doc || track.lan || "",
      lines: lines,
    };
  } catch (err) {
    return {
      ok: true,
      source: "subtitle",
      videoTitle: videoTitle,
      lanDoc: track.lan_doc || track.lan || "",
      subtitleUrl: subtitleUrl,
    };
  }
}
