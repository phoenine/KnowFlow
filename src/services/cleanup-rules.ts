export function cleanupPromotionalNoise(content: string): string {
  return content
    .split("\n")
    .filter((line) => !isSingleLineNoise(line))
    .join("\n");
}

export function removeCodeWatermarkLines(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^\s*复制代码\s*$/.test(line))
    .join("\n");
}

function isSingleLineNoise(line: string): boolean {
  return /^\s*(展开阅读全文|阅读原文|喜欢此内容的人还喜欢|继续滑动看下一个|向上滑动看下一个|微信扫一扫|扫码关注|扫码关注公众号|关注公众号|二维码)\s*$/i.test(line)
    || /^\s*(微信扫一扫|关注公众号|二维码|广告)\s*[:：]\s*.+$/i.test(line)
    || /^\s*\*\*(球分享|球点赞|球在看)\*\*\s*$/.test(line);
}
