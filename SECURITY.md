# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes. In
particular:

- **Secrets**: the passwords of the Dahua devices live in the Gladys
  configuration of the integration (`secret` fields). They are used only to
  answer the digest challenge of the configured devices (the password itself
  never travels), and are never written to the logs, to `/data`, to an error
  message or to the stream address shown to the user. An address typed with
  credentials (`user:pass@host`) is refused. A password refused once is never
  tried again without the user, so a device does not lock its account.
- **`/data`**: the only file is `dahua-state.json`: what each device is
  (serial, model, channels, capabilities) and the detections learned. No
  secret, no image. The table where a recorder keeps the passwords of its
  cameras (`RemoteDevice`) is read to list the channels, then dropped: never
  stored, never logged.
- **Network**: the integration talks only to the configured addresses (HTTP,
  or HTTPS when the address starts with `https://`; Dahua devices only have
  self-signed certificates, which are then accepted), never to a cloud.
- **Safety**: opening a door is disabled by default and is never a device
  feature (only a scene action, once allowed); the siren is disabled by
  default.
- **Camera images** stay in memory (the last ones, for the widget) and go to
  Gladys only.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the Dahua devices and their firmware (report those to Dahua).
