export function cleanupPromotionalNoise(content: string): string {
  const lines = content.split("\n");
  const cleaned = lines.filter((line) => !isSingleLineNoise(line));
  const cutoff = findFooterCutoff(cleaned);
  return cleaned.slice(0, cutoff).join("\n");
}

function isSingleLineNoise(line: string): boolean {
  return /^\s*(复制代码|展开阅读全文|阅读原文|喜欢此内容的人还喜欢|继续滑动看下一个|向上滑动看下一个|微信扫一扫|扫码关注|关注公众号|二维码)\s*$/i.test(line)
    || /^\s*(微信扫一扫|关注公众号|二维码|广告)\s*[:：]?.*$/i.test(line)
    || /^\s*\*\*(球分享|球点赞|球在看)\*\*\s*$/.test(line);
}

function findFooterCutoff(lines: string[]): number {
  const strongFooterPatterns = [
    /^本文由\s*@?.+原创发布于/,
    /^声明[:：].*(InfoQ|转载|版权)/,
    /^继续滑动看下一个/,
    /^向上滑动看下一个/
  ];
  const weakFooterHeadings = [
    /^今日好文推荐$/,
    /^会议推荐$/,
    /^推荐阅读$/
  ];
  const start = Math.max(Math.floor(lines.length * 0.75), lines.length - 80, 0);
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (strongFooterPatterns.some((pattern) => pattern.test(trimmed))) return index;
    if (weakFooterHeadings.some((pattern) => pattern.test(trimmed)) && hasFooterNoiseNearby(lines, index)) return index;
  }
  return lines.length;
}

function hasFooterNoiseNearby(lines: string[], index: number): boolean {
  const window = lines.slice(index + 1, Math.min(lines.length, index + 10));
  const noiseCount = window.filter((line) => {
    const trimmed = line.trim();
    return isSingleLineNoise(trimmed)
      || /二维码|扫码|关注公众号|阅读原文|分享|点赞|在看|转载|版权|活动报名|讲师介绍|商务合作/.test(trimmed)
      || /^!\[.*?二维码.*?\]/.test(trimmed)
      || /^!\[\]\(.+?\)$/.test(trimmed);
  }).length;
  return noiseCount >= 2;
}
