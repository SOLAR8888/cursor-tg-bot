import "dotenv/config";

const t = process.env.TELEGRAM_BOT_TOKEN;
console.log("token_len=" + (t?.length ?? "undef"));
console.log("token_first10=" + t?.slice(0, 10));
console.log("token_last4=" + t?.slice(-4));
console.log(
  "token_codes_first5=" +
    JSON.stringify([...(t ?? "").slice(0, 5)].map((c) => c.charCodeAt(0))),
);
console.log(
  "token_codes_last5=" +
    JSON.stringify([...(t ?? "").slice(-5)].map((c) => c.charCodeAt(0))),
);

if (!t) {
  console.log("ABORT: token undefined");
  process.exit(1);
}

const url = "https://api.telegram.org/bot" + t + "/getMe";
console.log("url_len=" + url.length);
try {
  const r = await fetch(url);
  console.log("status=" + r.status);
  console.log("body=" + (await r.text()));
} catch (err) {
  console.log("fetch_error=" + err.message);
}
