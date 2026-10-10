# Antigravity Workbench 0.1.9

## 简体中文

完善多账号额度查看、模型选择与可选定时任务。

- 在账号列表比较和排序模型额度，支持可取消的批量刷新、模型收藏、家族折叠分组及额度历史。
- 新增原生额度快速选择与可选账号／模型状态栏置顶；修复一次回车重复置顶，刷新保留搜索和活动项，避免旧状态回传覆盖已保存的收藏。
- 账号与图片页统一准确额度显示：未知不算作零，未满不显示满额，旧数据保留查询时间；刷新保持滚动、焦点和折叠状态。
- 图片页可按所选模型额度推荐账号，复用历史任务时保留模型并提示缺失参考图；支持统一隐藏身份。
- 新增默认关闭的额度提醒与定时请求，支持间隔、每日和 cron 计划、预览、手动测试、暂停与取消。
- 明确区分对话请求服务、账号模型目录与图片模型；高级设置收纳服务端点，未分类目录保留手动模型选择。
- 修复额度对比与排序在重载后的保存，以及中英文切换在各页面的即时同步。

## English

Improve multi-account quota viewing, model selection and optional scheduled tasks.

- Compare and sort model quotas in the account list, with cancelable batch refresh, model favorites, collapsible families and quota history.
- Add native quota QuickPick and an optional pinned account/model status item. Fix repeated pinning after one Enter; preserve search and the active item on refresh, and prevent older state echoes from overwriting saved favorites.
- Use accurate quota presentation across account and image pages: unknown is not zero, partial quota is not full, and stale data retains its observation time. Preserve scroll, focus and collapsed groups during refresh.
- Recommend image accounts using the selected model's quota, retain the model when reusing history and flag missing reference images. Add shared identity hiding.
- Add quota alerts and scheduled requests, disabled by default, with interval, daily and cron schedules, previews, manual tests, pause and cancel.
- Clarify conversation services, account model directories and image models. Keep service endpoints under advanced settings and retain manual selection for unclassified catalogs.
- Persist quota comparison and sorting across reloads, and synchronize manual language changes across pages.
