<template>
  <section class="gateway-admin" aria-labelledby="gateway-admin-title">
    <div class="card-title" id="gateway-admin-title">{{ $t('gatewayTitle') }}</div>
    <div class="card-content">
      <el-form label-position="top" @submit.prevent="saveSettings">
        <el-form-item :label="$t('gatewayAdminEnabled')">
          <el-switch v-model="enabled" :active-value="1" :inactive-value="0"
                     :disabled="disabled || saving" :aria-label="$t('gatewayAdminEnabled')" />
        </el-form-item>
        <el-form-item :label="$t('gatewayImapServer')">
          <el-input v-model="imapHostname" :maxlength="253" :disabled="disabled || saving"
                    :placeholder="$t('gatewayAdminImapHostnamePlaceholder')" autocomplete="off" />
          <el-button data-testid="test-imap" :loading="tests.imap.pending" :disabled="connectivity.blocked('imap')"
                     @click="connectivity.testConnection('imap')">{{ $t('gatewayProbeImap') }}</el-button>
          <p v-if="connectivity.dirty('imap')" class="help-text">{{ $t('gatewayProbeSaveFirst') }}</p>
          <p v-if="tests.imap.cooldown && !tests.imap.pending" class="help-text">{{ $t('gatewayProbeCooldown') }}</p>
          <div v-if="tests.imap.code" role="status" aria-live="polite" data-testid="imap-test-result">
            <p>{{ $t('gatewayProbeCode_' + tests.imap.code) }}</p>
            <p v-for="(status, phase) in tests.imap.result?.stages || {}" :key="phase">{{ $t('gatewayProbePhase_' + phase) }}: {{ $t('gatewayProbeStatus_' + status) }}</p>
          </div>
        </el-form-item>
        <el-form-item :label="$t('gatewaySmtpServer')">
          <el-input v-model="smtpHostname" :maxlength="253" :disabled="disabled || saving"
                    :placeholder="$t('gatewayAdminSmtpHostnamePlaceholder')" autocomplete="off" />
          <el-button data-testid="test-smtp" :loading="tests.smtp.pending" :disabled="connectivity.blocked('smtp')"
                     @click="connectivity.testConnection('smtp')">{{ $t('gatewayProbeSmtp') }}</el-button>
          <p v-if="connectivity.dirty('smtp')" class="help-text">{{ $t('gatewayProbeSaveFirst') }}</p>
          <p v-if="tests.smtp.cooldown && !tests.smtp.pending" class="help-text">{{ $t('gatewayProbeCooldown') }}</p>
          <div v-if="tests.smtp.code" role="status" aria-live="polite" data-testid="smtp-test-result">
            <p>{{ $t('gatewayProbeCode_' + tests.smtp.code) }}</p>
            <p v-for="(status, phase) in tests.smtp.result?.stages || {}" :key="phase">{{ $t('gatewayProbePhase_' + phase) }}: {{ $t('gatewayProbeStatus_' + status) }}</p>
          </div>
        </el-form-item>
        <p class="help-text">{{ $t('gatewayAdminHostnameHint') }}</p>
        <el-alert v-if="errorKey" :title="$t(errorKey)" type="error" show-icon :closable="false" />
        <p class="help-text">{{ $t('gatewayAdminVisibilityHint') }}</p>
        <p class="help-text">{{ $t('gatewayDeploymentRequired') }}</p>
        <p class="help-text">{{ $t('gatewayProbeHint') }}</p>
        <el-button type="primary" native-type="submit" :loading="saving" :disabled="disabled || saving">
          {{ $t('save') }}
        </el-button>
      </el-form>
    </div>
  </section>
</template>

<script setup>
import {computed, onBeforeUnmount} from 'vue'
import {useI18n} from 'vue-i18n'
import {ElMessage} from 'element-plus'
import {useSettingStore} from '@/store/setting.js'
import {settingSet, gatewayConnectivity} from '@/request/setting.js'
import {useGatewayConnectivity} from './use-gateway-connectivity.js'
import {useGatewayAdminSettings} from './use-gateway-admin-settings.js'

const props = defineProps({disabled: {type: Boolean, default: false}})
const emit = defineEmits(['saving'])
const {t} = useI18n()
const settingStore = useSettingStore()
const state = useGatewayAdminSettings(computed(() => settingStore.settings), settingSet)
const {enabled, imapHostname, smtpHostname, saving, errorKey} = state
const connectivity = useGatewayConnectivity(computed(() => settingStore.settings),
    {imap: imapHostname, smtp: smtpHostname}, saving, gatewayConnectivity, () => props.disabled)
const {tests} = connectivity

async function saveSettings() {
  if (props.disabled || saving.value) return
  emit('saving', true)
  try {
    if (await state.save()) ElMessage.success(t('saveSuccessMsg'))
  } finally {
    emit('saving', false)
  }
}
onBeforeUnmount(() => { connectivity.dispose(); state.dispose() })
</script>

<style scoped>
.card-title { font-size: 15px; font-weight: bold; padding: 15px 20px 12px; border-bottom: 1px solid var(--el-border-color); }
.card-content { padding: 20px; }
.help-text { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; margin: 8px 0 12px; overflow-wrap: anywhere; }
.el-form { min-width: 0; }
</style>
