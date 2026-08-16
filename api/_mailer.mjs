/**
 * Sending the two emails this app sends.
 *
 * Verification and password reset both work by putting a link in somebody's
 * inbox, which means the whole security of both rests on one property: the
 * link must reach the person and nobody else. Everything here is arranged
 * around that.
 *
 * There is no SMTP client and no mail dependency. Delivery is a webhook — the
 * server POSTs a small JSON body to whatever address the deployment
 * configures, and that endpoint is somebody's transactional mail provider,
 * their own relay, or a queue. An auth path is not a good place to take on a
 * dependency, and every provider worth using accepts an HTTP POST.
 *
 *   AUTH_MAIL_WEBHOOK   where to POST. Unset, nothing is delivered.
 *   AUTH_MAIL_TOKEN     optional bearer token for that endpoint.
 *   AUTH_MAIL_FROM      the From address to ask for.
 *   APP_URL             the origin links point at. Required for real links.
 *
 * With no webhook configured the mailer writes the link to the server log and
 * reports that it could not deliver. That is a real mode — it is how a local
 * run and a self-hosted first boot work — and the important part is that the
 * caller is *told*, so it can decide what to do rather than claiming an email
 * was sent that was not.
 */

/**
 * The rule that keeps this honest.
 *
 * A token is a live key to somebody's account. It goes in the mail body and
 * into the log; it must never travel back in an HTTP response, because the
 * whole point of emailing it is that only the mailbox owner sees it. Returning
 * it "just for development" is how a verification step becomes decoration —
 * so the seam for tests is the log, which lives on the server, and not the
 * response, which does not.
 */
export function createMailer({
  webhook = null,
  token = null,
  from = 'no-reply@localhost',
  appUrl = null,
  transport = fetch,
  log = console,
} = {}) {
  const canDeliver = Boolean(webhook);

  async function send({ to, subject, text, link, kind }) {
    if (!canDeliver) {
      /*
       * Written where an operator will find it, at a level that is not an
       * error. A first boot with no mail configured is a normal state, and
       * logging it as a failure trains people to ignore it.
       */
      log.warn?.(
        `[auth] no mail webhook configured — ${kind} link for ${to} not sent. Link: ${link}`,
      );
      return { delivered: false, reason: 'not-configured' };
    }

    try {
      const response = await transport(webhook, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ from, to, subject, text, kind }),
      });

      if (!response.ok) {
        // The status, not the body: a mail provider's error body can echo the
        // message, and the message contains the link.
        log.error?.(`[auth] mail webhook answered ${response.status} for ${kind}`);
        return { delivered: false, reason: 'rejected' };
      }
      return { delivered: true };
    } catch {
      log.error?.(`[auth] mail webhook unreachable for ${kind}`);
      return { delivered: false, reason: 'unreachable' };
    }
  }

  return {
    canDeliver,

    /** Where a link should point, or null when the deployment has not said. */
    linkTo(path, params) {
      if (!appUrl) return null;
      const url = new URL(path, appUrl);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url.toString();
    },

    async sendVerification({ to, name, token: linkToken }) {
      const link = this.linkTo('/', { verify: linkToken });
      return send({
        to,
        kind: 'verify',
        subject: 'Confirm your email address',
        link,
        text: [
          name ? `Hello ${name},` : 'Hello,',
          '',
          'Confirm this address to finish setting up your Surveyor account:',
          link ?? '(this deployment has no address configured for links)',
          '',
          'The link is good for 24 hours. If you did not create an account, ignore this.',
        ].join('\n'),
      });
    },

    async sendPasswordReset({ to, name, token: linkToken }) {
      const link = this.linkTo('/', { reset: linkToken });
      return send({
        to,
        kind: 'reset',
        subject: 'Reset your password',
        link,
        text: [
          name ? `Hello ${name},` : 'Hello,',
          '',
          'Use this link to set a new password:',
          link ?? '(this deployment has no address configured for links)',
          '',
          'It can be used once, within the hour. If you did not ask for this,',
          'nothing has changed and you can ignore this message.',
        ].join('\n'),
      });
    },
  };
}

export function mailerFromEnv(env = process.env, extra = {}) {
  return createMailer({
    webhook: env.AUTH_MAIL_WEBHOOK ?? null,
    token: env.AUTH_MAIL_TOKEN ?? null,
    from: env.AUTH_MAIL_FROM ?? 'no-reply@localhost',
    appUrl: env.APP_URL ?? env.VERCEL_URL_FULL ?? null,
    ...extra,
  });
}

/**
 * Whether this deployment insists on a verified address before sign-in.
 *
 * Defaults to whether mail can actually be delivered, which is the only
 * default that cannot lock everybody out: switching verification on with no
 * way to send the link would make every new account permanently unusable, and
 * the person who set it that way would have no account left to fix it with.
 * `AUTH_REQUIRE_VERIFICATION` overrides it in either direction for anyone who
 * knows what they are doing.
 */
export function verificationRequired(env = process.env, mailer) {
  const setting = env.AUTH_REQUIRE_VERIFICATION;
  if (setting === '1' || setting === 'true') return true;
  if (setting === '0' || setting === 'false') return false;
  return mailer.canDeliver;
}

/** Addresses this deployment grants `admin` to at registration. */
export function adminEmailsFromEnv(env = process.env) {
  return String(env.AUTH_ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}
