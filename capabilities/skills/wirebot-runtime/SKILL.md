---
name: wirebot-runtime
description: Explain Wirebot's container filesystem and persistence boundaries. Use when deciding where to store files, install software, preserve state, or understand what an image update replaces.
---

# Wirebot Runtime

Apply these boundaries when working inside a Wirebot image:

- Store user work in `/data/workspace`.
- Treat `/data`, `/data/home`, `/usr/local`, and `/home/linuxbrew` as persistent. The latter two paths are backed by the `/data` volume.
- Treat the rest of the filesystem as image-owned. Package installs made with `apt` disappear when the container is recreated from a newer image.
- Treat built-in skills in `/etc/codex/skills` as image-owned. Update them by building and deploying a new Wirebot image, not by modifying the running container.
- Store Codex login, configuration, user skills, and sessions in `/data/codex-home`.
