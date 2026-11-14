<template>
  <section class="gateway-settings" aria-labelledby="gateway-settings-title">
    <div class="section-heading">
      <div class="title" id="gateway-settings-title">{{ $t('gatewayTitle') }}</div>
      <el-button :loading="loading" :disabled="creating || Boolean(revokingId) || Boolean(oneTimeSecret)" @click="refresh">
        {{ $t('gatewayRefresh') }}
      </el-button>
    </div>
    <p class="help-text">{{ $t('gatewayIntro') }}</p>
    <el-alert v-if="errorKey" :title="$t(errorKey)" type="warning" show-icon :closable="false" role="status" />

    <template v-if="ready">
      <el-alert v-if="accountsErrorKey" :title="$t(accountsErrorKey)" type="warning" show-icon :closable="false" />
      <el-alert v-else-if="!accounts.length" :title="$t('gatewayNoAccounts')" type="info" show-icon :closable="false" />
      <el-form v-if="accounts.length" class="credential-form" label-position="top" @submit.prevent="createCredential">
        <el-form-item :label="$t('gatewayMailbox')">
          <el-select :model-value="selectedAccountId" :disabled="loading || creating || Boolean(revokingId)" @change="selectAccount">
            <el-option v-for="account in accounts" :key="account.accountId" :value="account.accountId"
                       :label="account.name ? `${account.email} (${account.name})` : account.email" />
          </el-select>
        </el-form-item>
        <el-form-item :label="$t('gatewayCredentialName')">
          <el-input v-model="credentialName" :maxlength="64" :placeholder="$t('gatewayCredentialNamePlaceholder')"
                    :disabled="loading || creating" autocomplete="off" />
        </el-form-item>
        <el-form-item :label="$t('gatewayPermissions')">
          <el-checkbox-group v-model="requestedPermissions" :disabled="loading || creating">
            <el-checkbox value="mail.read" disabled>{{ $t('gatewayPermissionRead') }}</el-checkbox>
            <el-checkbox value="mail.write">{{ $t('gatewayPermissionWrite') }}</el-checkbox>
            <el-checkbox v-if="canSend" value="mail.send">{{ $t('gatewayPermissionSend') }}</el-checkbox>
          </el-checkbox-group>
          <div class="help-text permission-help">{{ $t('gatewayPermissionsHint') }}</div>
        </el-form-item>
        <el-button native-type="submit" type="primary" :loading="creating"
                   :disabled="!selectedAccount || !credentialName.trim() || loading || Boolean(oneTimeSecret) || Boolean(revokingId)">
          {{ $t('gatewayCreatePassword') }}
        </el-button>
      </el-form>

      <el-alert v-if="actionErrorKey" :title="$t(actionErrorKey)" type="warning" show-icon :closable="false" role="status" />
      <el-alert v-if="createOutcomeUnknown" :title="$t('gatewayCreateUnknown')" type="warning" show-icon :closable="false" />

      <h3>{{ $t('gatewayPasswordList') }}</h3>
      <div class="table-scroll">
        <el-table :data="visibleAppPasswords" :empty-text="$t('gatewayNoPasswords')" :aria-label="$t('gatewayPasswordList')">
          <el-table-column prop="name" :label="$t('gatewayCredentialName')" min-width="140" />
          <el-table-column prop="mailboxAddress" :label="$t('gatewayMailbox')" min-width="200" />
          <el-table-column :label="$t('gatewayPermissions')" min-width="180">
            <template #default="{ row }">
              <span>{{ row.permissions.map(permissionLabel).join(' / ') || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="$t('gatewayCreatedAt')" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column :label="$t('gatewayLastUsedAt')" min-width="170">
            <template #default="{ row }">{{ row.lastUsedAt ? formatTime(row.lastUsedAt) : $t('gatewayNeverUsed') }}</template>
          </el-table-column>
          <el-table-column :label="$t('tabStatus')" min-width="110">
            <template #default="{ row }">
              <el-tag :type="row.revokedAt ? 'info' : 'success'">{{ $t(row.revokedAt ? 'gatewayRevoked' : 'gatewayActive') }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="$t('action')" min-width="110">
            <template #default="{ row }">
              <el-button type="danger" plain size="small" :disabled="Boolean(row.revokedAt) || creating || Boolean(revokingId)"
                         :loading="revokingId === row.id" @click="confirmRevoke(row)">
                {{ $t('gatewayRevoke') }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <el-collapse class="client-help">
      <el-collapse-item :title="$t('gatewayClientSetup')" name="client-setup">
        <el-alert :title="$t('gatewayDeploymentRequired')" type="warning" show-icon :closable="false" />
        <dl class="client-settings">
          <dt>{{ $t('gatewayServer') }}</dt><dd>{{ $t('gatewayServerHint') }}</dd>
          <dt>{{ $t('gatewayLoginName') }}</dt><dd>{{ selectedAccount?.email || $t('gatewaySelectedMailboxHint') }}</dd>
          <dt>{{ $t('password') }}</dt><dd>{{ $t('gatewayPasswordHint') }}</dd>
          <dt>IMAP</dt><dd>{{ $t('gatewayImapSettings') }}</dd>
          <dt>SMTP</dt><dd>{{ $t('gatewaySmtpSettings') }}</dd>
        </dl>
        <ol class="help-list">
          <li>{{ $t('gatewayIosStep1') }}</li>
          <li>{{ $t('gatewayIosStep2') }}</li>
          <li>{{ $t('gatewayIosStep3') }}</li>
        </ol>
        <p class="help-text">{{ $t('gatewayNoMxChange') }}</p>
      </el-collapse-item>
    </el-collapse>

    <template v-if="ready && selectedAccount">
      <div class="section-heading submissions-heading">
        <h3>{{ $t('gatewaySubmissions') }}</h3>
        <el-button :loading="submissionsLoading" :disabled="loading" @click="refreshSubmissions">{{ $t('gatewayRefresh') }}</el-button>
      </div>
      <p class="help-text">{{ $t('gatewaySubmissionsHint') }}</p>
      <el-alert :title="$t('gatewayUnknownWarning')" type="warning" show-icon :closable="false" />
      <el-alert v-if="submissionsErrorKey" :title="$t(submissionsErrorKey)" type="warning" show-icon :closable="false" role="status" />
      <div v-else class="table-scroll">
        <el-table :data="submissions" :empty-text="$t('gatewayNoSubmissions')" :aria-label="$t('gatewaySubmissions')">
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="recipient-results">
                <el-alert v-if="row.partial" :title="$t('gatewayPartialWarning')" type="warning" show-icon :closable="false" />
                <p v-if="!row.recipients.length" class="help-text">{{ $t('gatewayNoRecipientDetails') }}</p>
                <ul v-else class="help-list">
                  <li v-for="(recipient, index) in row.recipients" :key="index">
                    {{ recipient.address }} — {{ $t(`gatewayRecipientState_${recipient.state}`) }}
                  </li>
                </ul>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="id" :label="$t('gatewaySubmissionId')" min-width="150" />
          <el-table-column :label="$t('gatewayRecipients')" min-width="150">
            <template #default="{ row }">
              <el-tag v-if="row.partial" type="warning">{{ $t('gatewayPartial') }}</el-tag>
              <span v-else>{{ $t('gatewayRecipientCount', {count: row.recipients.length}) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="$t('tabStatus')" min-width="180">
            <template #default="{ row }"><el-tag :type="submissionPresentation(row.state).type">{{ $t(submissionPresentation(row.state).label) }}</el-tag></template>
          </el-table-column>
          <el-table-column :label="$t('gatewayStateExplanation')" min-width="280">
            <template #default="{ row }">{{ $t(submissionPresentation(row.state).description) }}</template>
          </el-table-column>
          <el-table-column :label="$t('gatewayCreatedAt')" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column :label="$t('gatewayUpdatedAt')" min-width="170">
            <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <el-dialog v-if="oneTimeSecret" :model-value="true" :title="$t('gatewayPasswordCreated')" width="min(520px, calc(100vw - 32px))"
               :close-on-click-modal="false" destroy-on-close @close="clearSecret" @update:model-value="clearSecret">
      <el-alert :title="$t('gatewayOneTimeWarning')" type="warning" show-icon :closable="false" />
      <p class="secret-mailbox">{{ oneTimeSecret.mailboxAddress }}</p>
      <code class="one-time-password" data-testid="one-time-password">{{ oneTimeSecret.password }}</code>
      <p class="help-text">{{ $t('gatewayClipboardHint') }}</p>
      <template #footer>
        <el-button @click="copyPassword">{{ $t('gatewayCopyPassword') }}</el-button>
        <el-button type="primary" @click="clearSecret">{{ $t('gatewaySavedPassword') }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup>
import {computed, onBeforeUnmount, onDeactivated, onMounted, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {ElMessage, ElMessageBox} from 'element-plus'
import gatewayApi from '@/request/gateway.js'
import {hasPerm} from '@/perm/perm.js'
import {useSettingStore} from '@/store/setting.js'
import {useGatewaySettings} from './use-gateway-settings.js'
import {submissionPresentation} from './gateway-model.js'

const {t, locale} = useI18n()
const settingStore = useSettingStore()
const canSend = computed(() => hasPerm('email:send') && settingStore.settings.send === 0)
const state = useGatewaySettings(gatewayApi)
const {
  accounts, visibleAppPasswords, submissions, selectedAccountId, selectedAccount,
  loading, creating, revokingId, submissionsLoading, errorKey, accountsErrorKey, actionErrorKey,
  submissionsErrorKey, createOutcomeUnknown, ready, oneTimeSecret, credentialName, requestedPermissions,
  refresh, refreshSubmissions, selectAccount, clearSecret,
} = state

watch(canSend, value => {
  if (!value) requestedPermissions.value = requestedPermissions.value.filter(permission => permission !== 'mail.send')
})

function createCredential() {
  return state.create(canSend.value ? ['mail.read', 'mail.write', 'mail.send'] : ['mail.read', 'mail.write'])
}

async function confirmRevoke(credential) {
  try {
    await ElMessageBox.confirm(t('gatewayRevokeConfirm', {name: credential.name}), t('gatewayRevoke'), {
      type: 'warning', confirmButtonText: t('gatewayRevoke'), cancelButtonText: t('cancel'),
    })
  } catch {
    return
  }
  if (await state.revoke(credential.id)) ElMessage.success(t('gatewayRevokedSuccess'))
}

async function copyPassword() {
  if (!oneTimeSecret.value) return
  try {
    // Copy only on an explicit user action; never log a clipboard error object.
    await navigator.clipboard.writeText(oneTimeSecret.value.password)
    ElMessage.success(t('gatewayCopied'))
  } catch {
    ElMessage.warning(t('gatewayCopyFailed'))
  }
}

function permissionLabel(permission) {
  return t({'mail.read': 'gatewayPermissionRead', 'mail.write': 'gatewayPermissionWrite', 'mail.send': 'gatewayPermissionSend'}[permission])
}

function formatTime(value) {
  const date = new Date(value)
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString(locale.value === 'zh' ? 'zh-CN' : 'en-US') : '—'
}

onMounted(refresh)
onDeactivated(clearSecret)
onBeforeUnmount(state.dispose)
</script>

<style scoped lang="scss">
.gateway-settings {
  width: 100%;
  min-width: 0;
  color: var(--regular-text-color);
  font-size: 14px;
  .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .title { font-size: 16px; font-weight: bold; color: var(--el-text-color-primary); }
  h3 { font-size: 14px; margin: 24px 0 12px; color: var(--el-text-color-primary); }
  .help-text { line-height: 1.65; color: var(--el-text-color-secondary); }
  :deep(.el-alert) { margin: 12px 0; }
  .credential-form { max-width: 520px; margin: 20px 0; }
  .permission-help { width: 100%; font-size: 12px; }
  .table-scroll { width: 100%; overflow-x: auto; }
  .client-help { margin-top: 24px; }
  .client-settings { display: grid; grid-template-columns: minmax(90px, auto) 1fr; gap: 12px 18px; line-height: 1.6; }
  dt { font-weight: 600; } dd { margin: 0; overflow-wrap: anywhere; }
  .help-list { padding-left: 20px; line-height: 1.8; overflow-wrap: anywhere; }
  .recipient-results { padding: 8px 24px; }
  .submissions-heading h3 { margin-bottom: 0; }
}
.one-time-password { display: block; padding: 18px; border: 1px solid var(--el-border-color); border-radius: 8px; user-select: text; overflow-wrap: anywhere; font-size: 17px; letter-spacing: 0.03em; }
.secret-mailbox { overflow-wrap: anywhere; }
</style>
