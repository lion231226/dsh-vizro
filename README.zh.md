# dsh-vizro（中文）

在 DeepSeek Harness 里**原生**构建、校验、运行与体检 [Vizro](https://github.com/mckinsey/vizro) 仪表盘——用工具与技能，**不经过 MCP server**。

Vizro 是麦肯锡开源的 Python 低代码数据应用框架：仪表盘是一棵 Pydantic 模型树，由 Dash/Plotly 渲染。这个插件把 agent 需要的四件事交到手上：模型契约、走生产路径的校验器、真实数据画像、以及"起来跑一下看是否真的在服务"的手段。

## 装了什么

| 面 | 数量 | 内容 |
| --- | --- | --- |
| 工具 | 7 | `vizro_schema`、`vizro_validate`、`vizro_data`、`vizro_scaffold`、`vizro_run`、`vizro_probe`、`vizro_doctor` |
| 技能 | 6 | `vizro-dashboard-design`、`vizro-dashboard-build`、`vizro-layouts`、`vizro-charts`、`vizro-actions`、`vizro-yaml` |
| 界面 | 1 | 设置里的 **Vizro** 面板：工作区应用、启停、内嵌预览、日志 |

## 安装

```bash
dsh plugin --profile <profile> add dsh-vizro
```

前提：DSH 支持插件 bundle；`PATH` 上有 [`uv`](https://docs.astral.sh/uv/)。sidecar 是一个 PEP 723 脚本，锁 `vizro==1.0.0`，`uv` 会在首次调用时准备 Python 3.11+ 与依赖（30–60 秒），之后走缓存；worker 常驻，空闲 10 分钟回收。

## 为什么不是 MCP

- 工具直接注册进 DSH 的工具表，没有 MCP 宿主配置、没有 stdio 握手、没有第二个要用户自己起的服务。
- Python 侧是一个说 JSON lines 的子进程，只做三件事：反射 schema、走生产 `model_validate`、给数据做画像。
- 校验通过 = 一定能 build；校验失败返回 `{loc,msg,type}`，`loc` 直接指到配置里的那一段。
- 起服务与体检由插件自己管：端口自动分配、日志环形缓冲、卸载时终止子进程。

## 边界（先读）

- `vizro_probe` 只做 HTTP + 日志级体检：能发现服务没起来、Dash 布局失败、日志里有 traceback；**不会**逐个点击交互组件，需要点击级检查时仍要浏览器工具。
- 插件以你的用户身份运行 Python：仪表盘文件能做的事，等同本地脚本。
- 锁定 Vizro 1.0.0，其它版本未测试。
- 唯一的界面入口是设置里的 Vizro 面板。

## 许可

MIT。内置技能改编自麦肯锡 `vizro` 仓库的 `vizro-e2e-flow`（Apache-2.0），见 `NOTICE`。

