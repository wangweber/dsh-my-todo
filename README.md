# dsh-my-todo

为 DeepSeek Harness 提供的全局跨会话待办插件：

- **全局持久**：一份待办存在 `$DSH_HOME/todos.json`，所有会话、所有工作区共用，不随会话销毁。
- **`my_todo` 工具**：模型在会话中增/删/改/查，支持按 id 或按内容定位；`action: 'open'` 是唯一的"打开待办页签"指令。
- **`/todo` 命令**：`/todo`、`/todo open` 打开页签；`/todo close` 关闭页签；`add/list/done/rm/clear-done` 只操作数据，不打开页签。
- **可开关的待办页签**：默认不占页签；只有明确的打开指令（`/todo open` 或 `my_todo open`）才注册 `conversation.view` 页签条目，页签内 × 关闭。
- **实时同步**：页签打开时，会话内任何待办变更（命令或工具）都会让视图自动刷新。

## 安装

```sh
dsh plugin --profile web add dsh-my-todo@latest
```

从源码开发：

```sh
pnpm install
pnpm run build
pnpm dsh web --patch ./cordis.patch.yml   # 在 deepseek-harness 仓库根目录下运行时
```

## 数据格式

`$DSH_HOME/todos.json`（默认 `~/.dsh/todos.json`）：

```json
{
  "version": 1,
  "todos": [
    {
      "id": "…",
      "content": "买牛奶",
      "status": "pending",
      "createdAt": 1755510000000,
      "updatedAt": 1755510000000
    }
  ]
}
```

写入采用原子写（临时文件 + rename），损坏文件会先备份再重建；最多 1000 条，单条 500 字符。

## 已知限制

- `/todo/api` 路由只接受回环地址（与官方 `/api` 的默认信任姿态一致），非回环部署需要扩展信任列表。
- 待办页签状态是全局的：一个会话打开，所有会话的页签环都出现该页签。
- 并发多进程写入为 last-write-wins（v1 不做锁）。
- **空白会话无任何命令反馈（官方 UI 行为，已实测确认）**：全新会话在发送第一条消息前，官方隐藏整个会话头部（含页签栏），正文只显示 Hero；
  命令结果以"流程节点"渲染在聊天流中，因此空白会话里执行任何 `/todo` 子命令（`open`/`list`/`add`/`done`/`rm`/`clear-done`）都会成功并写入日志，
  但界面上零反馈。发送第一条消息后，页签栏出现待办页签，命令结果也正常显示。
- 打开页签不会自动激活视图：官方没有公开的程序化切换页签 API，注册后需点击"待办"页签进入。
