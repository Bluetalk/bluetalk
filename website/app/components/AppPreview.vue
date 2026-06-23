<script setup lang="ts">
const messages = [
  { side: 'left', text: 'Hey — are you on the LAN?', time: '14:02' },
  { side: 'right', text: 'Yep. Direct connection, no relay.', time: '14:02' },
  { side: 'left', text: 'Perfect. Keys exchanged locally.', time: '14:03' },
  { side: 'right', text: 'Messages stay between us.', time: '14:03' },
]
</script>

<template>
  <div class="app-preview" aria-hidden="true">
    <div class="app-preview-glow" />

    <div class="app-window">
      <div class="app-window-chrome">
        <span class="app-window-dot app-window-dot--red" />
        <span class="app-window-dot app-window-dot--yellow" />
        <span class="app-window-dot app-window-dot--green" />
        <span class="app-window-title">BlueTalk</span>
        <span class="app-window-status">
          <span class="app-window-status-dot" />
          P2P connected
        </span>
      </div>

      <div class="app-window-body">
        <aside class="app-sidebar">
          <div class="app-sidebar-header">Chats</div>
          <div class="app-sidebar-item app-sidebar-item--active">
            <span class="app-avatar">A</span>
            <div class="app-sidebar-meta">
              <span class="app-sidebar-name">Alex</span>
              <span class="app-sidebar-preview">Messages stay between us.</span>
            </div>
          </div>
          <div class="app-sidebar-item">
            <span class="app-avatar app-avatar--muted">M</span>
            <div class="app-sidebar-meta">
              <span class="app-sidebar-name">Morgan</span>
              <span class="app-sidebar-preview">Offline</span>
            </div>
          </div>
        </aside>

        <div class="app-chat">
          <div class="app-chat-header">
            <span class="app-avatar">A</span>
            <div>
              <div class="app-chat-name">Alex</div>
              <div class="app-chat-sub">End-to-end encrypted · Direct</div>
            </div>
          </div>

          <div class="app-chat-messages">
            <div
              v-for="(msg, index) in messages"
              :key="index"
              class="app-bubble-row"
              :class="`app-bubble-row--${msg.side}`"
            >
              <div class="app-bubble">
                {{ msg.text }}
                <span class="app-bubble-time">{{ msg.time }}</span>
              </div>
            </div>
          </div>

          <div class="app-chat-input">
            <span class="app-chat-input-placeholder">Type a message…</span>
            <span class="app-chat-send">↑</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
