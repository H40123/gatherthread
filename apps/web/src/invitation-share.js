export function beijingDateTime(value, locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  if (locale !== "en") return formatter.format(date);
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function projectInvitationLink(secret, origin) {
  if (!/^gti_[A-Za-z0-9_-]{32,508}$/.test(secret)) throw new TypeError("Invitation secret is invalid");
  const server = new URL(origin);
  if (!["https:", "http:"].includes(server.protocol) || server.username || server.password) {
    throw new TypeError("Invitation server is invalid");
  }
  const link = new URL("/app/", server.origin);
  link.hash = new URLSearchParams({ invite: secret }).toString();
  return link.href;
}

export function projectInvitationShareText(secret, invitation, locale = "zh-CN", origin) {
  if (!secret) throw new TypeError("Invitation secret is unavailable");
  const link = origin ? projectInvitationLink(secret, origin) : null;
  const startsAt = beijingDateTime(invitation?.createdAt, locale);
  const expiresAt = beijingDateTime(invitation?.expiresAt, locale);
  if (locale === "en") {
    return [
      ...(link ? [`Invitation link: ${link}`, "Open the link, sign in or register with verified email, then confirm joining the project."] : []),
      `Invitation secret: ${secret}`,
      "If the link cannot be opened, sign in to GatherThread and enter this secret under “Join another project” in the right sidebar. New users must register with verified email first. An expired or revoked invitation requires a new invitation from the owner.",
      startsAt && expiresAt
        ? `Valid: ${startsAt} to ${expiresAt} (China Standard Time)`
        : "Valid: Please confirm with the inviter (the server did not provide the validity period).",
    ].join("\n");
  }
  return [
    ...(link ? [`邀请链接：${link}`, "打开链接，登录或验证邮箱注册后，确认加入项目。"] : []),
    `邀请密钥：${secret}`,
    "链接无法打开时，登录共序后，在工作页右侧栏的「加入其他项目」中输入上述密钥。首次使用请先验证邮箱、注册账号并登录。邀请过期或被撤销后，请向项目所有者索取新的邀请。",
    startsAt && expiresAt
      ? `有效期：${startsAt} 至 ${expiresAt}（北京时间）`
      : "有效期：请向邀请者确认（服务器未提供有效时间）。",
  ].join("\n");
}
