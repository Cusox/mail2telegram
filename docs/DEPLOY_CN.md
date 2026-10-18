
# 部署指南

[English](./DEPLOY.md) | 中文

本指南从零安装 **mail2telegram 2.0**。如果你要升级已有的 1.0 部署，请看[迁移指南](./MIGRATION_CN.md)（[English](./MIGRATION.md)）—— 它复用下面的部署步骤，并额外包含数据迁移。

## 1. 配置 Telegram

1. 使用 `@BotFather > /newbot` 创建机器人并复制 Token。
2. Mini App 需要设置隐私政策：`@BotFather > /mybots > (选择你的机器人) > Edit Bot > Edit Privacy Policy`，设置为 `https://telegram.org/privacy-tpa`。
3. 部署完成后，访问一次 `https://你的-worker-域名/init` 绑定 Webhook 并设置菜单按钮（[首次运行](#6-首次运行)中还会提到）。如果你没有设置 `DOMAIN`，Worker 也会在此处自动识别自己的域名。

## 2. 创建存储

如果你使用 Deploy to Cloudflare 按钮部署，可以跳过本节 —— Cloudflare 会自动创建 D1 数据库和 R2 存储桶。

```bash
npx wrangler d1 create mail2telegram                 # 必需
npx wrangler r2 bucket create mail2telegram          # 可选：附件
```

记下输出中的 D1 **database id**。R2 可选 —— 没有配置 `BUCKET` 绑定时，邮件仍会存入 D1，只是不包含附件内容。

## 3. 部署

### 方式 A —— Deploy to Cloudflare 按钮（最快）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TBXark/mail2telegram)

点击按钮、登录 Cloudflare 并按提示操作即可。Cloudflare 会把仓库克隆到你的账号下，按 `wrangler.jsonc` 声明创建 `D1` 数据库与 `R2` 存储桶，把真实 id 写回克隆后的仓库，并询问 `.dev.vars.example` 中的运行参数（`TELEGRAM_TOKEN`、`TELEGRAM_ID` 必填，其余可选）。随后它会执行 `package.json` 中的 `build` / `deploy` 脚本：应用 D1 迁移、构建 Mini App 并部署 Worker。

之后继续看[首次运行](#6-首次运行)完成机器人与 Email Routing 绑定。克隆出的仓库归你所有，可继续开发；Deploy to Cloudflare 按钮适用于全新部署，而不是更新已有部署。

### 方式 B —— Cloudflare Workers Builds（推荐用于持续开发）

连接 Git 之后，每次推送到生产分支都会自动构建并部署，无需再维护 CLI 凭据或 CI 配置。

1. Fork 或推送本仓库到 GitHub。
2. 在 Cloudflare 控制台进入 **Workers & Pages → Create → Workers → Connect to Git**，选择该仓库。
3. 设置构建参数：

   | 设置项                              | 值                                     |
   |:------------------------------------|:---------------------------------------|
   | Production branch                   | `master`                               |
   | Build command                       | `pnpm build`                           |
   | Deploy command                      | `pnpm run deploy`                      |
   | Root directory                      | 留空（仓库根目录）                     |
   | Non-production branch deploy command | 保持默认（`npx wrangler versions upload`） |

   `pnpm run deploy` 会注入资源 id、应用 D1 迁移、构建 Mini App 并部署 Worker。必须带 `run` —— 不带 `run` 的 `pnpm deploy` 会和 pnpm 内置的 workspace 命令冲突。
4. 添加 **build variables**（**Settings → Environment variables**，仅构建阶段可读）：

   | Build variable                  | 必填 | 说明                                       |
   |:--------------------------------|:-----|:-------------------------------------------|
   | `DEPLOY_D1_DATABASE_ID`         | 是   | `wrangler d1 create` 得到的 D1 数据库 id。 |
   | `DEPLOY_D1_DATABASE_NAME`       | 否   | D1 数据库名，默认 `mail2telegram`。        |
   | `DEPLOY_R2_BUCKET_NAME`         | 否   | 存放附件的 R2 存储桶，省略则不启用附件。   |
   | `DEPLOY_R2_PREVIEW_BUCKET_NAME` | 否   | 预览部署使用的 R2 存储桶。                 |

   这些值由 `scripts/build-config.mjs` 注入到生成的（已 gitignore 的）`wrangler.deploy.jsonc`；仓库里的 `wrangler.jsonc` 只按名称声明数据库与存储桶、并使用可自动创建的占位值，**不要把生产 id 写进它**。
5. **部署凭据无需手动配置。** 连接仓库时 Cloudflare 会自动生成部署令牌，你不用像方式 C 那样粘贴 `CLOUDFLARE_API_TOKEN`；该令牌默认已包含 D1 写权限，可直接执行 D1 迁移。只有当迁移步骤报 `Authentication error [code: 10000]` 或 `7403` 时，才需要到 **My Profile → API Tokens** 给它补上 `D1 Edit`。
6. **确认绑定名称**：`DB`（D1）、`BUCKET`（R2，启用附件时）、`AI`（Workers AI）。它们由 `scripts/build-config.mjs` 自动写入生成的配置，无需手动编辑。
7. 在 **Settings → Variables and Secrets** 中，按[运行参数与绑定](#4-运行参数与绑定)一节添加运行参数。注意 build variables 只在构建时可读，运行时读不到，所以运行参数必须在这里设置；`keep_vars: true` 保证后续部署不会删除它们。`TELEGRAM_TOKEN`、`RESEND_API_KEY` 请放入加密的 **Secrets** 区域。

### 方式 C —— GitHub Actions

仓库自带 [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)，作为手动备用通道：在 Actions 页手动触发后，它才会构建 Mini App、应用 D1 迁移并部署 Worker。它**不会**在 push 时自动运行 —— 方式 B 的 Workers Builds 已经会随每次 push 部署，两者同时开启会对同一次提交重复部署。

1. 在仓库 **Settings → Secrets and variables → Actions → Variables** 中添加：

   | 变量                     | 必填 | 说明                                       |
   |:-------------------------|:-----|:-------------------------------------------|
   | `CLOUDFLARE_ACCOUNT_ID`  | 是   | 通过 `wrangler whoami` 或控制台获取。      |
   | `DEPLOY_D1_DATABASE_ID`  | 是   | `wrangler d1 create` 得到的 D1 数据库 id。 |
   | `DEPLOY_R2_BUCKET_NAME`  | 否   | 存放附件的 R2 存储桶，省略则不启用附件。   |

2. 在 Cloudflare **My Profile → API Tokens** 创建 API Token：以 **Edit Cloudflare Workers** 模板为基础，追加 `D1 Edit`、`Workers R2 Storage Edit`、`Workers AI Edit` 权限。然后把它作为仓库 **Secret** `CLOUDFLARE_API_TOKEN` 添加（Secrets 页）。

3. 在 **Actions** 页手动运行该 workflow。方式 B 与方式 C 只保留一个，避免同一次提交重复部署。

### 方式 D —— 命令行

环境要求：Node.js 20.19+（Vite 7）和 pnpm。先执行 `npx wrangler login` 登录。

```bash
git clone git@github.com:TBXark/mail2telegram.git
cd mail2telegram
pnpm install
```

仓库中的 `wrangler.jsonc` 是公开配置，只按名称声明数据库与存储桶、并使用可自动创建的占位值，无需编辑。通过 `DEPLOY_*` 变量传入你的资源 id 并部署：

```bash
DEPLOY_D1_DATABASE_ID=你的-d1-id \
DEPLOY_R2_BUCKET_NAME=mail2telegram \
pnpm run deploy   # 应用 D1 迁移，构建 Mini App，部署 Worker
```

`DEPLOY_R2_BUCKET_NAME` 可选 —— 省略则不启用附件。`DEPLOY_D1_DATABASE_NAME` 默认 `mail2telegram`。

部署完成后，在控制台的 **Settings → Variables and Secrets** 中设置运行参数（`TELEGRAM_ID`、`TELEGRAM_TOKEN`，以及可选的 `RESEND_API_KEY`），与方式 B 相同。`wrangler.jsonc` 中的 `keep_vars: true` 保证后续部署不会删除它们。

`scripts/build-config.mjs` 会把这些 id 解析进生成的（已 gitignore 的）`wrangler.deploy.jsonc`；未配置的占位绑定会被跳过，不会部署。如果配置里已经带有真实 id（由 Deploy to Cloudflare 按钮写回，或你手动编辑），且没有设置 `DEPLOY_*` 变量，则会按原样部署。

## 4. 运行参数与绑定

所有行为都在 Mini App 中配置；Worker 本身只需要少量变量来标识机器人和可选的 API Key。

位置：Workers & Pages → 你的 worker → Settings → Variables and Secrets。这些变量**不**在 `wrangler.jsonc` 中设置。

| KEY              | 说明                                                                                                  |
|:-----------------|:------------------------------------------------------------------------------------------------------|
| `TELEGRAM_ID`    | 必填。推送目标 Chat ID，多个用英文逗号分隔。可通过 `@userinfobot` 获取，群组以 `-100` 开头。            |
| `TELEGRAM_THREAD_ID` | 可选。通知目标话题的正整数 ID（`message_thread_id`）。留空保持默认投递。同一个值应用于全部目标，适用于单个话题群；回信反馈和 /start 响应留在触发消息的话题中。 |
| `TELEGRAM_TOKEN` | 必填。Telegram Bot Token，例如 `7123456780:AAjkLAbvSgDdfsDdfsaSK0`。                                   |
| `DOMAIN`         | 可选。Worker 域名，例如 `project_name.user_name.workers.dev`，用于 Webhook 与 Mini App 链接。不设置时，Worker 会在运行安装步骤（`/init`）时自动发现并记住自己的域名（存入数据库）。仅当需要让 Mini App 运行在与安装时不同的域名上时才需要设置。 |
| `WEB_PASSWORD`   | 可选。在 Telegram 之外用普通浏览器打开 Mini App 时所需的密码。留空或不设置则只允许通过 Telegram Mini App 访问。 |
| `RESEND_API_KEY` | 可选。Resend API Key，https://resend.com/docs/introduction。启用后可在 Telegram 或 Mini App 中回信和撰写新邮件。   |
| `DEBUG`          | 可选。为 `true` 时推送会增加 `Debug` 按钮。                                                            |

其余全部在 Mini App 的 **Settings** 中管理：支持正则的白名单/黑名单、阻断策略、转发、摘要选项（Workers AI，或 OpenAI 兼容的 Base URL + Token，模型可从列表选择或手动填写）、摘要语言、重复通知拦截，以及邮件处理限制（保留时间与大小策略）。

如果之前部署过 1.0、习惯用变量配置行为，在 Mini App 中打开 **Settings → Bot & Webhook → Import from Environment**，一键把变量迁移到配置里，之后即可删除这些变量 —— 详见[迁移指南](./MIGRATION_CN.md)。

Bindings：

| Binding  | 类型         | 说明                                    |
|:---------|:-------------|:----------------------------------------|
| `DB`     | D1 Database  | 必需。邮件历史、地址名单、设置。        |
| `BUCKET` | R2 Bucket    | 附件与超大正文，可选。                  |
| `AI`     | Workers AI   | 可选，用于摘要。                        |

`DB` 和 `BUCKET` 由 `DEPLOY_D1_DATABASE_ID` / `DEPLOY_R2_BUCKET_NAME` 自动注入，无需在 `wrangler.jsonc` 中编辑绑定 id。

## 5. 配置 Cloudflare Email Routing

1. 在你的域名上启用 [Cloudflare Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/)。
2. 在 `Email Routing → Routing Rules` 中，将 `Catch-all address` 的动作设为 `Send to a Worker: mail2telegram`。
3. 如需备份所有邮件，在 Mini App 中开启转发并添加备份地址。该地址需要在 `Email Routing → Destination addresses` 中完成验证。

## 6. 首次运行

1. 访问一次 `https://你的-worker-域名/init`。
2. 给机器人发送 `/start`，通过菜单按钮打开 Mini App。
3. 在设置中录入白名单 / 黑名单 —— 其余参数之后也都可以在 Mini App 中调整。

## 7. 常见问题

**必须创建 R2 存储桶吗？**
不必，可选。不配置 `BUCKET` 时邮件仍存入 D1，只是不包含附件内容（超大正文按大小策略设置截断）。

**部署时报绑定相关错误？**
方式 B–D 中 `DEPLOY_D1_DATABASE_ID` 是必填项 —— 缺失时构建会直接报错并给出提示。`DEPLOY_R2_BUCKET_NAME` 可选：不配置时 R2 绑定会被自动省略，无需手动编辑或删除绑定块。方式 A 的 Deploy to Cloudflare 按钮会自行创建这两个资源，不涉及 `DEPLOY_*` 变量。
