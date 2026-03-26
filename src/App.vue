<template>
  <q-layout view="hHh lpR fFf">
    <q-page-container class="full-width">
      <q-page>
        <!-- Not authenticated - show auth dialog -->
        <div v-if="!authenticated" class="flex flex-center" style="height: 100vh">
          <template v-if="deepLinkShareId">
            <q-card style="min-width: 420px; max-width: 520px">
              <q-card-section>
                <div class="text-h6 text-center q-mb-md">Join a Shared MAIA Chat</div>
                <div class="text-body2 text-center q-mb-lg">
                  Enter your name and email to view the shared conversation. We’ll remember you for the next month on this device.
                </div>

                <div v-if="deepLinkLoading" class="text-center q-pa-md">
                  <q-spinner size="2em" />
                  <div class="q-mt-sm">Preparing your invitation...</div>
                </div>

                <div v-else>
                  <div v-if="deepLinkError" class="text-negative text-center q-mb-md">
                    {{ deepLinkError }}
                  </div>

                  <DeepLinkAccess
                    v-if="showDeepLinkAccess && deepLinkShareId"
                    :share-id="deepLinkShareId"
                    @authenticated="handleDeepLinkAuthenticated"
                  />

                  <div v-else class="text-center text-caption text-grey">
                    Awaiting invitation details...
                  </div>
                </div>
              </q-card-section>
            </q-card>
          </template>

          <template v-else>
            <q-card style="width: 95vw; max-width: 95vw; height: 95vh; max-height: 95vh; display: flex; flex-direction: column; overflow: hidden;">
              <q-card-section style="flex: 1; overflow-y: auto; display: flex; flex-direction: column;">
                <div class="text-h6 text-center q-mb-sm">
                  Welcome to MAIA
                </div>
                <!-- Multi-user selector: show when more than one known family member -->
                <div v-if="knownUsers.length > 1" class="text-center q-mb-sm">
                  <q-btn-toggle
                    v-model="selectedWelcomeUserId"
                    toggle-color="primary"
                    no-caps
                    dense
                    rounded
                    :options="knownUsers.map(u => ({ label: u.displayName, value: u.userId }))"
                    @update:model-value="onWelcomeUserSwitch"
                  />
                  <q-btn
                    flat dense round icon="person_add" size="sm" color="grey-6"
                    class="q-ml-xs"
                    @click="handleAddFamilyMember"
                  >
                    <q-tooltip>Add family member</q-tooltip>
                  </q-btn>
                </div>
                <!-- User Status line (USER_AUTH.md §2): black / orange / green by type -->
                <div class="text-center q-mb-md">
                  <p
                    class="q-ma-none text-body2"
                    :style="welcomeUserType === 'new' ? { color: '#1a1a1a' } : (welcomeUserType === 'local' && welcomeCloudValid === true) ? { color: '#2e7d32' } : (welcomeUserType === 'local' && welcomeCloudValid === null) ? { color: '#757575' } : welcomeUserType === 'local' ? { color: '#e65100' } : welcomeUserType === 'cloud' ? { color: '#2e7d32' } : {}"
                  >
                    <template v-if="welcomeUserStatusLine === '__passkey_link__'">
                      Get started with a new account or
                      <a
                        href="#"
                        style="color: #1976d2; text-decoration: underline; cursor: pointer"
                        @click.prevent="handlePasskeySignInLink"
                      >sign-in with a passkey</a>.
                    </template>
                    <template v-else>{{ welcomeUserStatusLine }}</template>
                  </p>
                  <!-- Cloud-invalid local user: inline restore/delete options on the status line -->
                  <div v-if="welcomeUserType === 'local' && welcomeCloudValid === false" class="q-mt-sm">
                    <q-btn
                      flat
                      dense
                      label="RESTORE FROM LOCAL FOLDER"
                      color="negative"
                      size="sm"
                      :loading="tempStartLoading"
                      @click="handleRestoreFromLocalFolder"
                    />
                    <span class="text-grey-6 q-mx-xs text-body2">or</span>
                    <q-btn
                      flat
                      dense
                      :label="`DELETE ${welcomeDisplayUserId}`"
                      color="negative"
                      size="sm"
                      :loading="deleteLocalUserLoading"
                      @click="handleDeleteLocalUser"
                    />
                  </div>
                </div>

                <div v-if="!showAuth">
                  <!-- GET STARTED is always the main action -->
                  <q-btn
                    label="GET STARTED"
                    color="primary"
                    size="lg"
                    class="full-width q-mb-sm"
                    :loading="tempStartLoading"
                    @click="handleGetStartedNoPassword"
                  />
                  <div v-if="tempStartError" class="text-negative text-center q-mb-md">
                    {{ tempStartError }}
                  </div>

                  <!-- Caption (full width, two columns) -->
                  <div class="q-mt-lg">
                    <div class="welcome-caption text-body2 text-grey-7 q-pa-md">
                      <vue-markdown :source="welcomeCaption || 'Loading...'" />
                    </div>
                  </div>

                  <!-- Privacy link at bottom -->
                  <div class="text-center q-mt-lg q-mb-md">
                    <a 
                      href="#" 
                      @click.prevent="showPrivacyDialog = true"
                      style="color: #1976d2; text-decoration: none; font-size: 0.9rem; cursor: pointer;"
                      class="text-primary"
                    >
                      Privacy, Security, Communities, and Risk
                    </a>
                  </div>
                </div>

                <p v-if="showAuth && welcomeBackPasskeyUserId" class="text-body2 text-center text-primary q-mb-md">
                  Welcome back. Sign in with your passkey for <strong>{{ welcomeBackPasskeyUserId }}</strong>.
                </p>
                <PasskeyAuth
                  v-if="showAuth"
                  :prefill-user-id="passkeyPrefillUserId"
                  :prefill-action="passkeyPrefillAction"
                  @authenticated="handleAuthenticated"
                  @cancelled="onPasskeyAuthCancelled"
                />
              </q-card-section>
            </q-card>
          </template>
        </div>

        <!-- Authenticated - show main interface or admin page -->
        <div v-else class="full-width full-height">
          <AdminUsers v-if="showAdminPage" />
          <ChatInterface
            v-else
            :user="user"
            :is-deep-link-user="isDeepLinkUser"
            :deep-link-info="deepLinkInfo"
            :restore-chat-state="restoredChatState"
            :rehydration-files="rehydrationFiles"
            :rehydration-active="rehydrationActive"
            :suppress-wizard="suppressWizard"
            :folder-access-tier="folderAccessTier"
            :passkey-without-folder="passkeyWithoutFolder"
            @sign-out="handleSignOut"
            @restore-applied="restoredChatState = null"
            @rehydration-complete="handleRehydrationComplete"
            @rehydration-file-removed="handleRehydrationFileRemoved"
            @update:deep-link-info="handleDeepLinkInfoUpdate"
            @local-folder-connected="handleLocalFolderConnected"
            @session-dirty="sessionDirty = true"
          />
        </div>
      </q-page>
    </q-page-container>
    
    <!-- More Choices: one set of actions; visibility/disabled by welcomeUserType -->
    <q-dialog v-model="showOtherAccountOptionsDialog" persistent>
      <q-card class="more-choices-card" style="min-width: 420px; max-width: 520px">
        <q-card-section>
          <div class="text-h6">More Choices</div>
          <p v-if="welcomeUserType === 'cloud'" class="text-body2 text-grey-8 q-mt-sm q-mb-none">
            {{ welcomeDisplayUserId }} is a cloud user with a passkey.
          </p>
          <p v-else-if="welcomeUserType === 'local'" class="text-body2 text-grey-8 q-mt-sm q-mb-none">
            {{ welcomeDisplayUserId }} is a local-only user (no passkey).
          </p>
          <p v-else class="text-body2 text-grey-8 q-mt-sm q-mb-none">
            No account on this device. Sign in with a passkey or manage an existing account.
          </p>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <div class="more-choices-actions column q-gutter-md">
            <q-btn
              unelevated
              color="primary"
              label="Sign-in as a different user"
              class="full-width"
              @click="openPasskeyFromOtherOptions"
            />
            <q-btn
              unelevated
              :color="welcomeDisplayUserId ? 'grey-8' : undefined"
              :flat="!welcomeDisplayUserId"
              :disable="!welcomeDisplayUserId"
              :label="welcomeDisplayUserId ? `Delete Cloud Account for ${welcomeDisplayUserId}` : 'Delete Cloud Account (sign in first)'"
              class="full-width"
              @click="onMoreChoicesDeleteCloud"
            />
            <q-btn
              unelevated
              :color="welcomeDisplayUserId ? 'negative' : undefined"
              :flat="!welcomeDisplayUserId"
              :disable="!welcomeDisplayUserId"
              :label="welcomeDisplayUserId ? `Delete Local Storage for ${welcomeDisplayUserId}` : 'Delete Local Storage (none on this device)'"
              class="full-width"
              @click="onMoreChoicesDeleteLocal"
            />
            <q-btn flat label="Cancel" color="primary" class="full-width q-mt-sm" @click="closeOtherAccountOptions" />
          </div>
        </q-card-section>
      </q-card>
    </q-dialog>

    <!-- More Choices: confirmation before delete -->
    <q-dialog v-model="showMoreChoicesConfirmDialog" persistent>
      <q-card style="min-width: 360px; max-width: 480px">
        <q-card-section>
          <div class="text-h6">{{ moreChoicesConfirmTitle }}</div>
          <p class="text-body2 q-mt-sm q-mb-none">{{ moreChoicesConfirmMessage }}</p>
        </q-card-section>
        <q-card-actions vertical align="stretch" class="q-gutter-sm">
          <template v-if="moreChoicesConfirmKind === 'delete-cloud' && (welcomeUserType === 'cloud' || user?.userId)">
            <q-btn
              unelevated
              color="primary"
              label="Keep local backup and delete cloud account"
              class="full-width"
              @click="confirmDeleteCloudKeepLocal"
            />
            <q-btn
              unelevated
              color="negative"
              label="Delete cloud account and local backup"
              class="full-width"
              @click="confirmDeleteCloudAndLocal"
            />
          </template>
          <template v-else-if="moreChoicesConfirmKind === 'delete-cloud'">
            <q-btn
              unelevated
              color="negative"
              label="DELETE"
              class="full-width"
              @click="confirmDeleteCloudOnly"
            />
          </template>
          <template v-else-if="moreChoicesConfirmKind === 'delete-local'">
            <q-btn
              unelevated
              color="negative"
              label="DELETE"
              class="full-width"
              @click="confirmDeleteLocalStorage"
            />
          </template>
          <q-btn flat label="CANCEL" color="primary" class="full-width" @click="closeMoreChoicesConfirm" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Privacy Dialog -->
    <PrivacyDialog v-model="showPrivacyDialog" />

    <!-- Device privacy choice -->
    <q-dialog v-model="showDevicePrivacyDialog" persistent>
      <q-card style="min-width: 420px; max-width: 520px">
        <q-card-section>
          <div class="text-h6">Is this computer private to you?</div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="SHARED"
            color="negative"
            @click="handleSharedDevice"
          />
          <q-btn
            flat
            label="PRIVATE"
            color="primary"
            @click="handlePrivateDevice"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Shared device warning -->
    <q-dialog v-model="showSharedDeviceWarning" persistent>
      <q-card style="min-width: 460px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Shared Computer Notice</div>
        </q-card-section>
        <q-card-section class="text-body2">
          MAIA normally keeps a backup of your private information on the local computer and browser.
          If you are using a shared computer you must set a Passkey to protect your information and
          MAIA will not keep a local backup.
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="OK"
            color="primary"
            @click="handleSharedWarningOk"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Non-Chrome browser warning -->
    <q-dialog v-model="showNotChromeDialog" persistent>
      <q-card style="min-width: 460px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Chrome Recommended</div>
        </q-card-section>
        <q-card-section class="text-body2">
          MAIA works best in Chrome because it can access an entire local folder
          for your health records, rather than requiring you to select individual
          files one at a time. Other browsers have limited support for folder-level
          access.
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="CONTINUE IN THIS BROWSER"
            color="primary"
            @click="handleContinueNonChrome"
          />
          <q-btn
            unelevated
            label="LET ME START OVER IN CHROME"
            color="primary"
            @click="showNotChromeDialog = false"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Non-Chrome: create a MAIA folder first -->
    <q-dialog v-model="showCreateFolderDialog" persistent>
      <q-card style="min-width: 460px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Create Your MAIA Folder</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            Before continuing, please pause here and go create a folder on this
            computer — for example <strong>AG MAIA files</strong> — and put whatever
            health record files you want indexed into that folder. Use a name that
            identifies the patient so you don't accidentally mix records.
          </p>
          <p class="text-negative text-weight-medium q-mb-none">
            Important: Be sure not to mix records from different patients into the
            same folder.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            unelevated
            label="I HAVE MY HEALTH RECORDS FOLDER"
            color="primary"
            @click="handleFolderReady"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Passkey sign-out: cross-device info -->
    <q-dialog v-model="showPasskeyBackupPromptModal" persistent>
      <q-card style="min-width: 420px; max-width: 560px">
        <q-card-section>
          <div class="text-h6">Passkey Created</div>
          <p class="text-body2 q-mt-sm q-mb-none">
            Passkeys allow you to access your MAIA on other devices or browsers.
            The MAIA folder you created this account from may not be available or
            would be a privacy risk on these other devices. Although your cloud
            MAIA account will be updated, your local MAIA folder will not be
            updated until the next time you access MAIA from the same original device.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn unelevated label="OK" color="primary" @click="onPasskeyBackupNo" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Sign-out: prompt to choose folder for saving updated files -->
    <q-dialog v-model="showSignOutFolderPrompt" persistent>
      <q-card style="min-width: 420px; max-width: 560px">
        <q-card-section>
          <div class="text-h6">Save Updated Files</div>
          <p class="text-body2 q-mt-sm q-mb-none">
            Download your updated log and database backup to keep your local
            MAIA folder in sync with your cloud account.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="SKIP" color="grey" @click="signOutFolderSkip" />
          <q-btn
            unelevated
            label="DOWNLOAD BACKUP"
            color="primary"
            :loading="signOutFolderSaving"
            @click="signOutFolderPick"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Passkey backup: 4-digit PIN to encrypt -->
    <q-dialog v-model="showPasskeyBackupPinDialog" persistent>
      <q-card style="min-width: 360px; max-width: 440px">
        <q-card-section>
          <div class="text-h6">Encrypt local backup</div>
          <p class="text-body2 q-mt-sm q-mb-md">
            Enter a 4-digit PIN to encrypt your local backup. You will need this PIN to restore on this device.
          </p>
          <q-input
            v-model="passkeyBackupPin"
            type="password"
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="4"
            placeholder="4-digit PIN"
            dense
            outlined
            :error="!!passkeyBackupPinError"
            :error-message="passkeyBackupPinError"
            autocomplete="off"
            @keyup.enter="submitPasskeyBackupPin"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="CANCEL" color="primary" @click="closePasskeyBackupPinDialog" />
          <q-btn unelevated label="SAVE" color="primary" :loading="passkeyBackupPinLoading" :disable="(passkeyBackupPin || '').length !== 4" @click="submitPasskeyBackupPin" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Passkey dialog for authenticated users -->
    <q-dialog v-model="showPasskeyDialog" persistent>
      <q-card style="min-width: 420px; max-width: 520px">
        <q-card-section>
          <div class="text-h6 text-center q-mb-md">Add a Passkey</div>
        </q-card-section>
        <q-card-section>
          <PasskeyAuth
            :prefill-user-id="passkeyPrefillUserId"
            :prefill-action="passkeyPrefillAction"
            @authenticated="handlePasskeyAuthenticated"
            @cancelled="showPasskeyDialog = false"
          />
        </q-card-section>
      </q-card>
    </q-dialog>

    <!-- Temporary account sign-out confirmation -->
    <q-dialog v-model="showTempSignOutDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Sign Out</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            Signing out ends this session and keeps your account for later. You can restore it on this device.
          </p>
          <p class="q-mt-md">
            Use <strong>DESTROY ACCOUNT</strong> only if you want to permanently delete your cloud data.
          </p>
          <div class="q-mt-md q-pa-md" style="border: 1px solid #e0e0e0; border-radius: 4px;">
            <strong>Note:</strong> You can add a passkey to your account instead of destroying it. You will then be able to sign-out the usual way and sign-in from other computers.
            <div class="q-mt-sm">
              <q-btn
                flat
                dense
                color="primary"
                label="CREATE A PASSKEY"
                @click="startPasskeyRegistration"
              />
            </div>
          </div>
        </q-card-section>
        <q-card-actions align="between" class="full-width">
          <q-btn flat label="DESTROY ACCOUNT" color="negative" @click="openDestroyDialog" />
          <div class="row items-center">
            <q-btn flat label="CANCEL" color="primary" @click="showTempSignOutDialog = false" />
            <q-btn flat label="SIGN OUT" color="primary" @click="handleTemporarySignOut" />
          </div>
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Dormant account choice for standard users -->
    <q-dialog v-model="showDormantDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Sign Out Options</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            You have {{ dormantDeepLinkCount }} active deep link{{ dormantDeepLinkCount === 1 ? '' : 's' }}.
            If you go dormant, those links will stop working until you reactivate your account.
          </p>
          <p class="q-mt-md">
            Choose <strong>KEEP SERVER LIVE</strong> to keep your deep links active.
            Choose <strong>GO DORMANT</strong> to save a local backup and delete your knowledge base.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="KEEP SERVER LIVE"
            color="primary"
            :disable="dormantLoading"
            @click="handleLiveSignOut"
          />
          <q-btn
            flat
            label="GO DORMANT"
            color="negative"
            :disable="dormantLoading"
            @click="handleDormantSignOut"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Restore local backup dialog -->
    <q-dialog v-model="showRestoreDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Restore Local Backup?</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            We found a local backup from <strong>{{ restoreSnapshot?.user?.userId }}</strong>.
            This can restore your saved chats and current chat draft to the new temporary account.
          </p>
          <p class="q-mt-md">
            Your files must be re-uploaded if the server was deleted.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="SKIP"
            color="primary"
            :disable="restoreLoading"
            @click="handleSkipRestore"
          />
          <q-btn
            flat
            label="RESTORE"
            color="negative"
            :disable="restoreLoading"
            @click="handleRestoreSnapshot"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Delete local user confirmation dialog (from welcome page) -->
    <q-dialog v-model="showDeleteLocalUserDialog" persistent>
      <q-card style="min-width: 420px; max-width: 540px">
        <q-card-section>
          <div class="text-h6">Delete {{ welcomeDisplayUserId }}?</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            This will permanently delete all cloud data for <strong>{{ welcomeDisplayUserId }}</strong>
            (files, knowledge base, agent) and remove the local backup from this device.
          </p>
          <p class="q-mt-md">
            The next time you click GET STARTED, a new account will be created.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="CANCEL"
            color="primary"
            :disable="deleteLocalUserLoading"
            @click="showDeleteLocalUserDialog = false"
          />
          <q-btn
            flat
            :label="`DELETE ${welcomeDisplayUserId}`"
            color="negative"
            :loading="deleteLocalUserLoading"
            @click="confirmDeleteLocalUser"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Missing agent dialog (legacy — kept for temporary session flow) -->
    <q-dialog v-model="showMissingAgentDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Local Backup Found</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            We found a local backup for <strong>{{ missingAgentUserId }}</strong>, but no matching agent is available.
          </p>
          <p class="q-mt-md">
            Choose what to do with the local backup.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="CLEAR LOCAL STORAGE"
            color="primary"
            @click="handleClearLocalBackup"
          />
          <q-btn
            flat
            label="START THE WIZARD AGAIN"
            color="negative"
            @click="handleStartWizardAgain"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Phase 4: Confirm new account creation when known users exist -->
    <q-dialog v-model="showNewAccountConfirmDialog" persistent>
      <q-card style="min-width: 400px; max-width: 520px">
        <q-card-section>
          <div class="text-h6">Create New Account?</div>
        </q-card-section>
        <q-card-section class="text-body2">
          {{ newAccountConfirmMessage }}
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat label="Cancel" color="grey-7"
            @click="showNewAccountConfirmDialog = false; pendingNewAccountCallback = null"
          />
          <q-btn
            flat label="Yes, Create New Account" color="primary"
            @click="() => { showNewAccountConfirmDialog = false; if (pendingNewAccountCallback) { pendingNewAccountCallback(); pendingNewAccountCallback = null; } }"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Cloud health dialog — shown on sign-in when cloud resources are missing -->
    <q-dialog v-model="showCloudHealthDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Cloud Resources Unavailable</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            Some cloud resources for your account are no longer available:
          </p>
          <ul class="q-mt-sm q-mb-md" style="padding-left: 1.2rem;">
            <li v-if="cloudHealthDetails?.database && !cloudHealthDetails.database.ok">
              <strong>Database</strong> — {{ cloudHealthDetails.database.error || 'not found' }}
            </li>
            <li v-if="cloudHealthDetails?.agent && !cloudHealthDetails.agent.ok">
              <strong>AI Agent</strong> — {{ cloudHealthDetails.agent.error || 'not found' }}
            </li>
            <li v-if="cloudHealthDetails?.knowledgeBase && !cloudHealthDetails.knowledgeBase.ok">
              <strong>Knowledge Base</strong> — {{ cloudHealthDetails.knowledgeBase.error || 'not found' }}
            </li>
            <li v-if="cloudHealthDetails?.spacesFiles && !cloudHealthDetails.spacesFiles.ok">
              <strong>Stored Files</strong> — {{ cloudHealthDetails.spacesFiles.error || 'not found' }}
            </li>
          </ul>
          <p>
            Would you like to restore from your local MAIA folder, or start fresh with a new account?
          </p>
        </q-card-section>
        <q-card-actions align="right" class="q-gutter-sm">
          <q-btn
            flat
            label="Start fresh"
            color="grey-8"
            :loading="cloudHealthLoading"
            @click="handleCloudStartFresh"
          />
          <q-btn
            unelevated
            label="Restore from local folder"
            color="primary"
            :loading="cloudHealthLoading"
            @click="handleCloudRestore"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Phase 7: Restore Wizard -->
    <RestoreWizard
      v-model="showRestoreWizard"
      :user-id="user?.userId || ''"
      :cloud-health="cloudHealthDetails"
      :local-state="restoreWizardLocalState"
      :local-folder-handle="localFolderHandle"
      @restore-complete="handleRestoreWizardComplete"
    />

    <!-- Destroyed account restore dialog -->
    <q-dialog v-model="showDestroyedRestoreDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Account Previously Deleted</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            The account <strong>{{ destroyedUserId }}</strong> was previously deleted from the cloud,
            but your local MAIA folder still has a backup of your files and settings.
          </p>
          <p class="q-mt-md">
            Would you like to <strong>restore</strong> your account from the local backup,
            or <strong>start fresh</strong> with a new account?
          </p>
        </q-card-section>
        <q-card-actions align="right" class="q-gutter-sm">
          <q-btn
            flat
            label="Start fresh"
            color="grey-8"
            :loading="cloudHealthLoading"
            @click="handleDestroyedStartFresh"
          />
          <q-btn
            unelevated
            label="Restore from local backup"
            color="primary"
            :loading="cloudHealthLoading"
            @click="handleDestroyedRestore"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Confirm destroy dialog -->
    <q-dialog v-model="showDestroyDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Destroy Account</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            This permanently deletes your cloud data for <strong>{{ user?.userId }}</strong>.
            Signing out is reversible; destroying is not.
          </p>
          <p class="q-mt-md">
            Type <strong>{{ user?.userId }}</strong> to confirm:
          </p>
          <q-input
            v-model="destroyConfirm"
            dense
            outlined
            placeholder="Enter user ID"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            label="DESTROY"
            color="negative"
            :loading="destroyLoading"
            :disable="destroyConfirm !== user?.userId"
            @click="destroyTemporaryAccount"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import VueMarkdown from 'vue-markdown-render';

// Store route check interval and event listener for cleanup (must be at top level)
const routeCheckInterval = ref<ReturnType<typeof setInterval> | null>(null);
const checkRouteRef = ref<(() => void) | null>(null);

// Register cleanup hook at top level (before any async operations)
onUnmounted(() => {
  if (routeCheckInterval.value) {
    clearInterval(routeCheckInterval.value);
    routeCheckInterval.value = null;
  }
  if (checkRouteRef.value) {
    window.removeEventListener('popstate', checkRouteRef.value);
    checkRouteRef.value = null;
  }
  window.removeEventListener('beforeunload', beforeUnloadHandler);
});
import PasskeyAuth from './components/PasskeyAuth.vue';
import RestoreWizard from './components/RestoreWizard.vue';
import ChatInterface from './components/ChatInterface.vue';
import DeepLinkAccess from './components/DeepLinkAccess.vue';
import PrivacyDialog from './components/PrivacyDialog.vue';
import AdminUsers from './components/AdminUsers.vue';
import { useQuasar } from 'quasar';
import { saveUserSnapshot, getLastSnapshotUserId, getUserSnapshot, clearLastSnapshotUserId, clearUserSnapshot, getPasskeyBackupPromptSkip, setPasskeyBackupPromptSkip, saveUserSnapshotEncrypted } from './utils/localDb';
import {
  writeStateFile, clearDirectoryHandle, readIdentityFile, writeIdentityFile,
  addOrUpdateKnownUser, removeKnownUser, migrateToKnownUsers,
  getKnownUsers, getActiveUserId, setActiveUserId,
  type MaiaState, type MaiaIdentity, type KnownUser
} from './utils/localFolder';

interface User {
  userId: string;
  displayName: string;
  isDeepLink?: boolean;
  isTemporary?: boolean;
  isAdmin?: boolean;
  hasPasskey?: boolean;
  credentialID?: string;
  deepLinkInfo?: DeepLinkInfo | null;
}

interface DeepLinkInfo {
  shareId: string | null;
  chatId?: string | null;
}

interface SignOutSnapshot {
  currentChat?: {
    messages: any[];
    uploadedFiles: any[];
    inputMessage: string;
    providerKey: string;
    providerLabel: string;
    savedChatId?: string | null;
    savedChatShareId?: string | null;
  };
}

const DEFAULT_TITLE = 'MAIA User App';

const authenticated = ref(false);
const showAuth = ref(false);
const user = ref<User | null>(null);
const isDeepLinkUser = ref(false);
const deepLinkInfo = ref<DeepLinkInfo | null>(null);
const deepLinkShareId = ref<string | null>(null);
const showDeepLinkAccess = ref(false);
const deepLinkLoading = ref(false);
const deepLinkError = ref('');
const showPrivacyDialog = ref(false);
const showAdminPage = ref(false);
const welcomeCaption = ref<string>('');
const tempStartLoading = ref(false);
const tempStartError = ref('');
const showTempSignOutDialog = ref(false);
const showDestroyDialog = ref(false);
const destroyConfirm = ref('');
const destroyLoading = ref(false);
const passkeyPrefillUserId = ref<string | null>(null);
const passkeyPrefillAction = ref<'signin' | 'register' | null>(null);
/** When set, we showed PasskeyAuth for a returning passkey user (from Get Started + local snapshot). */
const welcomeBackPasskeyUserId = ref<string | null>(null);
const showPasskeyDialog = ref(false);
const showPasskeyBackupPromptModal = ref(false);
const passkeyBackupDoNotAskAgain = ref(false);
const showPasskeyBackupPinDialog = ref(false);
const passkeyBackupPin = ref('');
const passkeyBackupPinError = ref('');
const passkeyBackupPinLoading = ref(false);
const showDormantDialog = ref(false);
const dormantDeepLinkCount = ref(0);
const dormantLoading = ref(false);
const signOutSnapshot = ref<SignOutSnapshot | null>(null);
const showSignOutFolderPrompt = ref(false);
const signOutFolderSaving = ref(false);
const showRestoreDialog = ref(false);
const restoreLoading = ref(false);
const restoreSnapshot = ref<any | null>(null);
const restoredChatState = ref<any | null>(null);
const rehydrationFiles = ref<any[]>([]);
const rehydrationActive = ref(false);
const suppressWizard = ref(false);
const showMissingAgentDialog = ref(false);
const missingAgentUserId = ref<string | null>(null);
const showCloudHealthDialog = ref(false);
const cloudHealthDetails = ref<any>(null);
const cloudHealthLoading = ref(false);
/** [Phase 7] Restore Wizard state */
const showRestoreWizard = ref(false);
const restoreWizardLocalState = ref<MaiaState | null>(null);
const pendingLocalUserId = ref<string | null>(null);
const showDestroyedRestoreDialog = ref(false);
const destroyedUserId = ref<string | null>(null);
const showDevicePrivacyDialog = ref(false);
const showSharedDeviceWarning = ref(false);
const deviceChoiceResolved = ref(false);
const sharedComputerMode = ref(false);
const showNotChromeDialog = ref(false);
const showCreateFolderDialog = ref(false);

/** Browser folder-access capability tier:
 *  'chrome'  – Full File System Access API (persistent read/write)
 *  'safari'  – webkitdirectory one-time folder read; sync on sign-out only
 *  'basic'   – No folder access; single-file-at-a-time fallback */
type FolderTier = 'chrome' | 'safari' | 'basic';
const folderAccessTier = ref<FolderTier>('basic');

const detectFolderAccessTier = (): FolderTier => {
  if (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function') return 'chrome';
  // Safari and Firefox support <input webkitdirectory> for one-time folder reads
  if (typeof document !== 'undefined') {
    const input = document.createElement('input');
    if ('webkitdirectory' in input) return 'safari';
  }
  return 'basic';
};
folderAccessTier.value = detectFolderAccessTier();

// ── Local folder (File System Access API) state ───────────────
const localFolderHandle = ref<FileSystemDirectoryHandle | null>(null);
const localFolderName = ref<string | null>(null);
/** [Phase 5] True when user signed in via passkey but has no local folder on this device. */
const passkeyWithoutFolder = ref(false);
/** [Phase 6] Dirty flag — true when session state changed since last save. */
const sessionDirty = ref(false);
const showOtherAccountOptionsDialog = ref(false);
const showDeleteLocalUserDialog = ref(false);
const deleteLocalUserLoading = ref(false);
const pendingAccountAction = ref<'backup-and-delete' | 'delete-only' | 'confirm-delete-cloud' | null>(null);
const showMoreChoicesConfirmDialog = ref(false);
const moreChoicesConfirmKind = ref<'delete-cloud' | 'delete-local' | null>(null);
/** [AUTH] Welcome status: from /api/welcome-status and localStorage (for status line and flow branching). */
const welcomeStatus = ref<{
  authenticated?: boolean;
  userId?: string;
  isTemporary?: boolean;
  tempCookieUserId?: string;
  tempCookieHasPasskey?: boolean;
  cloudFileCount?: number;
  cloudIndexedCount?: number;
}>({});
const welcomeLocalUserId = ref<string | null>(null);
/** When we have only local storage (no cookie), true if that userId has a passkey (Cloud User). */
const welcomeLocalHasPasskey = ref<boolean | null>(null);
/** [AUTH] Local snapshot details (files indexed, medications/summary verified); loaded when welcomeLocalUserId is set. */
const welcomeLocalSnapshot = ref<{
  fileCount: number;
  indexedCount: number;
  medicationsVerified: boolean;
  summaryVerified: boolean;
} | null>(null);
/** [AUTH] Whether the DO GenAI agent exists for the local userId (null = not yet checked). */
const welcomeAgentExists = ref<boolean | null>(null);
/** [AUTH] Cloud file count for the local userId from CouchDB (null = not yet checked). */
const welcomeCloudFileCount = ref<number | null>(null);
/** [AUTH] Saved file count (excluding References) for the local userId (null = not yet checked). */
const welcomeSavedFileCount = ref<number | null>(null);
/** [AUTH] Whether KB exists for the local userId. */
const welcomeKbExists = ref<boolean | null>(null);
/** [AUTH] Whether agent is linked to KB. */
const welcomeAgentLinkedToKb = ref<boolean | null>(null);
/** [AUTH] Whether wizard is complete (verified patient summary). */
const welcomeWizardComplete = ref<boolean | null>(null);

/** [AUTH] Classify welcome into New / Local / Cloud for status line and copy (USER_AUTH.md §1–2). */
const welcomeUserType = computed(() => {
  const localId = welcomeLocalUserId.value;
  const ws = welcomeStatus.value;
  const cookieUserId = ws.tempCookieUserId;
  const cookieHasPasskey = ws.tempCookieHasPasskey;
  const localHasPasskey = welcomeLocalHasPasskey.value;
  if (!localId && !cookieUserId) return 'new' as const;
  if (cookieUserId && cookieHasPasskey) return 'cloud' as const;
  if (cookieUserId && !cookieHasPasskey) return 'local' as const;
  if (localId && localHasPasskey === true) return 'cloud' as const;
  if (localId) return 'local' as const;
  return 'new' as const;
});

/** [AUTH] True when cloud account is fully set up: KB exists with saved files, agent linked, wizard complete. */
const welcomeCloudValid = computed(() => {
  if (!welcomeLocalUserId.value) return null;
  const snap = welcomeLocalSnapshot.value;
  const savedCount = welcomeSavedFileCount.value;
  const kbOk = welcomeKbExists.value === true;
  const linkedOk = welcomeAgentLinkedToKb.value === true;
  const wizardOk = welcomeWizardComplete.value === true;
  // Saved files in cloud match or exceed local snapshot count
  const filesOk = savedCount !== null && (!snap || snap.fileCount === 0 || savedCount >= snap.fileCount);
  const valid = kbOk && linkedOk && wizardOk && filesOk;
  console.log(`[WELCOME] cloudValid: kb=${kbOk}, linked=${linkedOk}, wizard=${wizardOk}, files=${savedCount}/${snap?.fileCount ?? '?'} → ${valid}`);
  return valid;
});

/** [AUTH] Single User Status line below "Welcome to MAIA" (USER_AUTH.md §2). */
const welcomeUserStatusLine = computed(() => {
  const type = welcomeUserType.value;
  const localId = welcomeLocalUserId.value;
  const snap = welcomeLocalSnapshot.value;
  const ws = welcomeStatus.value;
  if (type === 'new') return '__passkey_link__'; // handled in template
  if (type === 'local') {
    const userId = ws.tempCookieUserId || localId || '';
    const savedCount = welcomeSavedFileCount.value ?? snap?.fileCount ?? 0;
    if (welcomeCloudValid.value === true) {
      return `${userId} is ready to continue with ${savedCount} saved file${savedCount === 1 ? '' : 's'}.`;
    }
    // Still loading cloud validity — show neutral message to avoid red flash
    if (welcomeCloudValid.value === null && welcomeKbExists.value === null) {
      return `Checking ${userId} account status…`;
    }
    // Show what's missing in cloud — but use local backup info when available
    const localFiles = snap?.fileCount ?? 0;
    const localComplete = snap && snap.medicationsVerified && snap.summaryVerified;
    if (localFiles > 0 && localComplete) {
      // Local backup is healthy — cloud just needs restoring
      return `${userId} has a local backup with ${localFiles} file${localFiles === 1 ? '' : 's'} ready to restore.`;
    }
    const parts: string[] = [];
    if (!welcomeKbExists.value) parts.push('no knowledge base');
    if (!welcomeAgentLinkedToKb.value) parts.push('agent not linked');
    if (!welcomeWizardComplete.value && !localComplete) parts.push('wizard incomplete');
    const reason = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `${userId} has a local backup with ${localFiles} file${localFiles === 1 ? '' : 's'}${reason}.`;
  }
  const userId = ws.tempCookieUserId || localId || '';
  const hasLocalBackup = !!welcomeLocalUserId.value;
  return hasLocalBackup
    ? `${userId} has a passkey and local backup available.`
    : `${userId} has a passkey and no local backup available.`;
});

/** [AUTH] New client = no local backup and no temp cookie. */
const isNewClient = computed(() => !welcomeLocalUserId.value && !welcomeStatus.value.tempCookieUserId);

/** [MULTI-USER] Known family members on this device. */
const knownUsers = ref<KnownUser[]>([]);
/** [MULTI-USER] Currently selected userId in the Welcome page selector. */
const selectedWelcomeUserId = ref<string | null>(null);

/** Refresh knownUsers from localStorage. */
const refreshKnownUsers = () => {
  knownUsers.value = getKnownUsers();
  // Auto-select: active user, or first known user
  if (!selectedWelcomeUserId.value || !knownUsers.value.some(u => u.userId === selectedWelcomeUserId.value)) {
    selectedWelcomeUserId.value = getActiveUserId() || knownUsers.value[0]?.userId || null;
  }
};

/** When user switches in the multi-user toggle, reload welcome status for that user. */
const onWelcomeUserSwitch = (userId: string) => {
  setActiveUserId(userId);
  // Override welcomeLocalUserId to the selected user so all status computeds update
  welcomeLocalUserId.value = userId;
  void loadWelcomeStatus();
};

/** Add family member: go through new-account flow */
const handleAddFamilyMember = () => {
  // Clear any existing user context and start fresh
  welcomeLocalUserId.value = null;
  welcomeStatus.value = {};
  showDevicePrivacyDialog.value = true;
};

/** [PHASE 4] Confirmation dialog for new account creation */
const showNewAccountConfirmDialog = ref(false);
const newAccountConfirmMessage = ref('');
const pendingNewAccountCallback = ref<(() => void) | null>(null);

/** [AUTH] userId to show in More Choices heading (cookie or local). */
const welcomeDisplayUserId = computed(() => welcomeStatus.value.tempCookieUserId || welcomeLocalUserId.value || '');

/** Confirmation dialog title for More Choices delete actions. */
const moreChoicesConfirmTitle = computed(() => {
  const uid = moreChoicesConfirmUserId.value || welcomeDisplayUserId.value;
  if (moreChoicesConfirmKind.value === 'delete-cloud') return uid ? `Delete Cloud Account for ${uid}` : 'Delete Cloud Account';
  if (moreChoicesConfirmKind.value === 'delete-local') return uid ? `Delete Local Storage for ${uid}` : 'Delete Local Storage';
  return 'Confirm';
});
/** Confirmation dialog message for More Choices delete actions. */
const moreChoicesConfirmMessage = computed(() => {
  const uid = moreChoicesConfirmUserId.value || welcomeDisplayUserId.value;
  if (moreChoicesConfirmKind.value === 'delete-cloud') {
    const isCloudOrAuthenticated = welcomeUserType.value === 'cloud' || !!user.value?.userId;
    if (isCloudOrAuthenticated) {
      return 'You can keep a local backup on this device (account can be recovered later) or delete the cloud account and local backup.';
    }
    return uid
      ? `This will permanently delete the cloud account for ${uid}. This device's local backup will remain until you delete it.`
      : 'This will permanently delete your cloud account.';
  }
  if (moreChoicesConfirmKind.value === 'delete-local') {
    return uid
      ? `This will remove the local backup for ${uid} from this device. The cloud account (if any) is not affected.`
      : 'This will remove the local backup from this device.';
  }
  return '';
});
const moreChoicesConfirmUserId = ref<string | null>(null);

/** [AUTH] Load welcome-status and localStorage for status line and branching. */
const loadWelcomeStatus = async () => {
  refreshKnownUsers();
  // Use selected user from multi-user selector, fall back to old single-user key
  welcomeLocalUserId.value = selectedWelcomeUserId.value || getLastSnapshotUserId();
  welcomeLocalSnapshot.value = null;
  welcomeLocalHasPasskey.value = null;
  welcomeAgentExists.value = null;
  welcomeCloudFileCount.value = null;
  welcomeSavedFileCount.value = null;
  welcomeKbExists.value = null;
  welcomeAgentLinkedToKb.value = null;
  welcomeWizardComplete.value = null;
  const localId = welcomeLocalUserId.value;
  console.log(`[WELCOME] loadWelcomeStatus: localId=${localId || 'none'}`);
  if (localId) {
    try {
      const [snapshot, passkeyRes, agentRes] = await Promise.all([
        getUserSnapshot(localId),
        fetch(`/api/passkey/check-user?userId=${encodeURIComponent(localId)}`, { credentials: 'include' }),
        fetch(`/api/agent-exists?userId=${encodeURIComponent(localId)}`)
      ]);
      if (passkeyRes.ok) {
        const passkeyData = await passkeyRes.json();
        welcomeLocalHasPasskey.value = !!passkeyData.hasPasskey;
      }
      if (agentRes.ok) {
        const agentData = await agentRes.json();
        welcomeAgentExists.value = !!agentData?.exists;
        welcomeCloudFileCount.value = agentData?.cloudFileCount ?? null;
        welcomeSavedFileCount.value = agentData?.savedFileCount ?? null;
        welcomeKbExists.value = agentData?.kbExists ?? null;
        welcomeAgentLinkedToKb.value = agentData?.agentLinkedToKb ?? null;
        welcomeWizardComplete.value = agentData?.wizardComplete ?? null;
        console.log(`[WELCOME] cloud status for ${localId}: agent=${agentData?.exists}, savedFiles=${agentData?.savedFileCount}, kb=${agentData?.kbExists}, linked=${agentData?.agentLinkedToKb}, wizardDone=${agentData?.wizardComplete}, stage=${agentData?.workflowStage}`);
      } else {
        console.warn(`[WELCOME] agent-exists call failed: ${agentRes.status}`);
        welcomeAgentExists.value = false;
      }
      // Prefer local folder maia-state.json (most accurate after sign-out), fall back to IndexedDB
      let localFileCount = 0;
      let localIndexedCount = 0;
      let localMedsVerified = false;
      let localSummaryVerified = false;
      let localWizardComplete = false;
      let foundLocalState = false;
      if (localFolderHandle.value) {
        try {
          const { readStateFile } = await import('./utils/localFolder');
          const folderState = await readStateFile(localFolderHandle.value);
          if (folderState) {
            foundLocalState = true;
            localFileCount = Array.isArray(folderState.files) ? folderState.files.length : 0;
            localIndexedCount = Array.isArray(folderState.files) ? folderState.files.filter(f => f.cloudStatus === 'indexed').length : 0;
            localMedsVerified = !!(folderState.currentMedications != null && String(folderState.currentMedications).trim() !== '');
            localSummaryVerified = !!(folderState.patientSummary != null && String(folderState.patientSummary).trim() !== '');
            localWizardComplete = !!folderState.wizardComplete;
            console.log(`[WELCOME] local folder state for ${localId}: files=${localFileCount}, indexed=${localIndexedCount}, medsVerified=${localMedsVerified}, summaryVerified=${localSummaryVerified}, wizardComplete=${localWizardComplete}`);
          }
        } catch (e) {
          console.warn('[WELCOME] Failed to read local folder state:', e);
        }
      }
      if (!foundLocalState && snapshot) {
        const fileStatusSummary = snapshot.fileStatusSummary || snapshot.files || [];
        localFileCount = Array.isArray(fileStatusSummary) ? fileStatusSummary.length : 0;
        localIndexedCount = Array.isArray(snapshot.fileStatusSummary)
          ? snapshot.fileStatusSummary.filter((f: any) => f?.chipStatus === 'indexed').length
          : 0;
        localMedsVerified = !!(snapshot.currentMedications != null && String(snapshot.currentMedications).trim() !== '');
        localSummaryVerified = !!(snapshot.patientSummary != null && String(snapshot.patientSummary).trim() !== '');
        foundLocalState = true;
        console.log(`[WELCOME] IndexedDB snapshot for ${localId}: files=${localFileCount}, indexed=${localIndexedCount}, medsVerified=${localMedsVerified}, summaryVerified=${localSummaryVerified}`);
      }
      if (foundLocalState) {
        welcomeLocalSnapshot.value = {
          fileCount: localFileCount,
          indexedCount: localIndexedCount,
          medicationsVerified: localMedsVerified,
          summaryVerified: localSummaryVerified
        };
        // If cloud says wizard incomplete but local folder says it was complete, trust local
        if (localWizardComplete && welcomeWizardComplete.value === false) {
          welcomeWizardComplete.value = true;
        }
      } else {
        console.log(`[WELCOME] no local snapshot for ${localId}`);
      }
    } catch (err) {
      console.warn('[WELCOME] loadWelcomeStatus error:', err);
      welcomeLocalSnapshot.value = null;
    }
  }
  try {
    const res = await fetch('/api/welcome-status', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.authenticated && data.userId) return;
    welcomeStatus.value = {
      tempCookieUserId: data.tempCookieUserId || undefined,
      tempCookieHasPasskey: data.tempCookieHasPasskey,
      cloudFileCount: data.cloudFileCount,
      cloudIndexedCount: data.cloudIndexedCount
    };
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[AUTH] welcome-status failed:', e);
    }
  }
};

const $q = useQuasar();

const setAuthenticatedUser = (userData: any, deepLink: DeepLinkInfo | null = null) => {
  if (!userData) return;
  const normalizedUser: User = {
    userId: userData.userId,
    displayName: userData.displayName || userData.userId,
    isDeepLink: !!userData.isDeepLink,
    isTemporary: !!userData.isTemporary,
    isAdmin: !!userData.isAdmin,
    deepLinkInfo: userData.deepLinkInfo || null
  };

  user.value = normalizedUser;
  authenticated.value = true;
  showAuth.value = false;
  isDeepLinkUser.value = !!normalizedUser.isDeepLink;

  // Update window title to include user ID
  if (typeof document !== 'undefined') {
    document.title = `MAIA for ${normalizedUser.userId}`;
  }

  // Check if user is on /admin but is not an admin - redirect to root
  if (typeof window !== 'undefined') {
    const isAdminPage = window.location.pathname === '/admin';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    // In production (non-localhost), redirect away from /admin after authentication
    // This prevents new users from seeing the admin page after registration
    // The backend will enforce admin access if they try to access admin routes
    if (normalizedUser.isAdmin) {
      showAdminPage.value = true;
      if (!isAdminPage) {
        window.history.replaceState({}, '', '/admin');
      }
    } else if (isAdminPage && !isLocalhost && !normalizedUser.isAdmin) {
      // Redirect to root - backend will enforce admin access if needed
      window.history.replaceState({}, '', '/');
      showAdminPage.value = false;
    }
  }

  if (isDeepLinkUser.value) {
    const sessionInfo = userData.deepLinkInfo || {};
    const resolvedShareId = (deepLink && deepLink.shareId) || sessionInfo.activeShareId || deepLinkShareId.value || (Array.isArray(sessionInfo.shareIds) ? sessionInfo.shareIds[0] : null) || null;
    const resolvedChatId = (deepLink && deepLink.chatId) || sessionInfo.chatId || null;
    if (resolvedShareId) {
      deepLinkShareId.value = resolvedShareId;
    }
    deepLinkInfo.value = {
      shareId: resolvedShareId,
      chatId: resolvedChatId
    };
    showDeepLinkAccess.value = false;
  } else {
    deepLinkInfo.value = deepLink;
  }

  // Register in the multi-user registry (skip deep-link users)
  if (!normalizedUser.isDeepLink) {
    addOrUpdateKnownUser({
      userId: normalizedUser.userId,
      displayName: normalizedUser.displayName || normalizedUser.userId,
      folderName: localFolderName.value || null,
      hasPasskey: !!userData.hasPasskey || !!userData.credentialID,
      lastActive: new Date().toISOString()
    });
    setActiveUserId(normalizedUser.userId);
  }
};

const onPasskeyAuthCancelled = () => {
  showAuth.value = false;
  welcomeBackPasskeyUserId.value = null;
  pendingAccountAction.value = null;
};

const closeOtherAccountOptions = () => {
  showOtherAccountOptionsDialog.value = false;
};

const openPasskeyFromOtherOptions = () => {
  showOtherAccountOptionsDialog.value = false;
  passkeyPrefillUserId.value = null;
  passkeyPrefillAction.value = null;
  showAuth.value = true;
};

/** Open confirmation for Delete Cloud Account; if no userId, require passkey first. */
const onMoreChoicesDeleteCloud = () => {
  const uid = welcomeDisplayUserId.value;
  if (!uid) {
    pendingAccountAction.value = 'confirm-delete-cloud';
    showOtherAccountOptionsDialog.value = false;
    passkeyPrefillUserId.value = null;
    passkeyPrefillAction.value = 'signin';
    showAuth.value = true;
    return;
  }
  if (welcomeUserType.value === 'cloud') {
    moreChoicesConfirmUserId.value = uid;
    moreChoicesConfirmKind.value = 'delete-cloud';
    showMoreChoicesConfirmDialog.value = true;
    showOtherAccountOptionsDialog.value = false;
    return;
  }
  if (welcomeUserType.value === 'local') {
    moreChoicesConfirmUserId.value = uid;
    moreChoicesConfirmKind.value = 'delete-cloud';
    showMoreChoicesConfirmDialog.value = true;
    showOtherAccountOptionsDialog.value = false;
    return;
  }
  showOtherAccountOptionsDialog.value = false;
  passkeyPrefillUserId.value = uid || null;
  pendingAccountAction.value = 'confirm-delete-cloud';
  passkeyPrefillAction.value = 'signin';
  showAuth.value = true;
};

/** Open confirmation for Delete Local Storage. */
const onMoreChoicesDeleteLocal = () => {
  const uid = welcomeDisplayUserId.value;
  if (!uid) return;
  moreChoicesConfirmUserId.value = uid;
  moreChoicesConfirmKind.value = 'delete-local';
  showMoreChoicesConfirmDialog.value = true;
  showOtherAccountOptionsDialog.value = false;
};

const closeMoreChoicesConfirm = () => {
  showMoreChoicesConfirmDialog.value = false;
  moreChoicesConfirmKind.value = null;
  moreChoicesConfirmUserId.value = null;
};

const confirmDeleteCloudKeepLocal = () => {
  closeMoreChoicesConfirm();
  pendingAccountAction.value = 'backup-and-delete';
  if (user.value?.userId) {
    void runPendingAccountClosure();
  } else {
    const uid = moreChoicesConfirmUserId.value || welcomeDisplayUserId.value;
    passkeyPrefillUserId.value = uid || null;
    passkeyPrefillAction.value = 'signin';
    showAuth.value = true;
  }
};
const confirmDeleteCloudAndLocal = () => {
  closeMoreChoicesConfirm();
  pendingAccountAction.value = 'delete-only';
  if (user.value?.userId) {
    void runPendingAccountClosure();
  } else {
    const uid = moreChoicesConfirmUserId.value || welcomeDisplayUserId.value;
    passkeyPrefillUserId.value = uid || null;
    passkeyPrefillAction.value = 'signin';
    showAuth.value = true;
  }
};
const confirmDeleteCloudOnly = async () => {
  const uid = moreChoicesConfirmUserId.value || welcomeDisplayUserId.value;
  closeMoreChoicesConfirm();
  if (welcomeUserType.value === 'local' && uid) {
    showOtherAccountOptionsDialog.value = false;
    tempStartLoading.value = true;
    tempStartError.value = '';
    try {
      const res = await fetch('/api/temporary/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: uid })
      });
      const data = await res.json();
      if (!res.ok || !data.authenticated || !data.user) throw new Error(data.error || 'Could not restore session');
      setAuthenticatedUser(data.user, null);
      const response = await fetch('/api/self/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: uid })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to delete account');
      }
      await clearUserSnapshot(uid);
      await performSignOut();
      void loadWelcomeStatus();
    } catch (e) {
      tempStartError.value = e instanceof Error ? e.message : 'Failed';
      if (typeof console !== 'undefined' && console.warn) console.warn('[AUTH] Delete cloud failed:', e);
    } finally {
      tempStartLoading.value = false;
    }
    return;
  }
  passkeyPrefillUserId.value = uid || null;
  pendingAccountAction.value = 'delete-only';
  passkeyPrefillAction.value = 'signin';
  showAuth.value = true;
};

const confirmDeleteLocalStorage = async () => {
  const uid = moreChoicesConfirmUserId.value || welcomeDisplayUserId.value;
  closeMoreChoicesConfirm();
  if (!uid) return;
  try {
    await clearUserSnapshot(uid);
    // Clear the httpOnly temp-user cookie via server so the welcome screen resets
    await fetch('/api/auth/clear-temp-cookie', { method: 'POST', credentials: 'include' }).catch(() => {});
    void loadWelcomeStatus();
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) console.warn('[AUTH] Clear local snapshot failed:', e);
    if (typeof $q?.notify === 'function') {
      $q.notify({ type: 'negative', message: 'Failed to clear local storage', timeout: 3000 });
    }
  }
};

const runPendingAccountClosure = async () => {
  const action = pendingAccountAction.value;
  pendingAccountAction.value = null;
  showAuth.value = false;
  if (!user.value?.userId) return;
  try {
    if (action === 'backup-and-delete') {
      await saveLocalSnapshot(null);
      await fetch('/api/account/dormant', { method: 'POST', credentials: 'include' });
      await performSignOut();
    } else if (action === 'delete-only') {
      const userIdToDelete = user.value.userId;
      const response = await fetch('/api/self/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: userIdToDelete })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete account');
      }
      await clearUserSnapshot(userIdToDelete);
      await performSignOut();
    }
  } catch (error) {
    console.error('Account closure error:', error);
    if (typeof window !== 'undefined' && $q?.notify) {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Account closure failed',
        timeout: 5000
      });
    }
  }
};

const handleAuthenticated = async (userData: any) => {
  const pending = pendingAccountAction.value;
  if (pending === 'confirm-delete-cloud') {
    setAuthenticatedUser(userData, null);
    showAuth.value = false;
    pendingAccountAction.value = null;
    moreChoicesConfirmUserId.value = userData?.userId || null;
    moreChoicesConfirmKind.value = 'delete-cloud';
    showMoreChoicesConfirmDialog.value = true;
    return;
  }
  if (pending) {
    setAuthenticatedUser(userData, null);
    void runPendingAccountClosure();
    return;
  }
  const pendingDeepLink =
    deepLinkShareId.value
      ? { shareId: deepLinkShareId.value, chatId: null }
      : null;
  setAuthenticatedUser(userData, pendingDeepLink);

  // After authentication, if on /admin path (and not localhost), redirect to root
  // This fixes the issue where new users end up on /admin after registration
  if (typeof window !== 'undefined') {
    const isAdminPage = window.location.pathname === '/admin';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (userData?.isAdmin) {
      showAdminPage.value = true;
      if (!isAdminPage) {
        window.history.replaceState({}, '', '/admin');
      }
      return; // skip health check for admins
    } else if (isAdminPage && !isLocalhost && !userData?.isAdmin) {
      // Redirect to root after a brief delay to ensure state is updated
      setTimeout(() => {
        window.location.href = '/';
      }, 100);
    }
  }

  // Cloud health check — verify all resources are still available
  if (userData?.userId && !userData?.isAdmin && !pendingDeepLink) {
    try {
      const healthResp = await fetch(
        `/api/cloud-health?userId=${encodeURIComponent(userData.userId)}`,
        { credentials: 'include' }
      );
      if (healthResp.ok) {
        const health = await healthResp.json();
        if (!health.healthy) {
          console.warn('[cloud-health] Resources missing:', health.details);
          cloudHealthDetails.value = health.details;
          showCloudHealthDialog.value = true;
        }
      }
    } catch (e) {
      console.warn('[cloud-health] Health check failed:', e);
      // Don't block sign-in if health check itself fails
    }
  }

  // Phase 5: Detect passkey-only session (no local folder on this device)
  if (userData?.hasPasskey || userData?.credentialID) {
    passkeyWithoutFolder.value = !localFolderHandle.value;
  }
};

const handleDeepLinkAuthenticated = (payload: { user: User; deepLinkInfo: DeepLinkInfo }) => {
  setAuthenticatedUser({ ...payload.user, isDeepLink: true, deepLinkInfo: payload.deepLinkInfo }, payload.deepLinkInfo);
  showDeepLinkAccess.value = false;
  deepLinkLoading.value = false;
  deepLinkError.value = '';
};

const handlePasskeyAuthenticated = (userData: any) => {
  showPasskeyDialog.value = false;
  handleAuthenticated(userData);
};

const resetAuthState = () => {
  authenticated.value = false;
  user.value = null;
  isDeepLinkUser.value = false;
  deepLinkInfo.value = null;
  showAuth.value = false;
  passkeyPrefillUserId.value = null;
  passkeyPrefillAction.value = null;
  welcomeBackPasskeyUserId.value = null;
  pendingAccountAction.value = null;
  showPasskeyDialog.value = false;
  showPasskeyBackupPromptModal.value = false;
  showPasskeyBackupPinDialog.value = false;
  passkeyBackupPin.value = '';
  passkeyBackupPinError.value = '';
  passkeyBackupPinLoading.value = false;
  passkeyBackupDoNotAskAgain.value = false;
  showDeepLinkAccess.value = !!deepLinkShareId.value;
  showMoreChoicesConfirmDialog.value = false;
  moreChoicesConfirmKind.value = null;
  moreChoicesConfirmUserId.value = null;

  if (typeof document !== 'undefined') {
    document.title = DEFAULT_TITLE;
  }
  void loadWelcomeStatus();
};

const saveLocalSnapshot = async (snapshot?: SignOutSnapshot | null) => {
  if (!user.value?.userId || user.value.isDeepLink || sharedComputerMode.value) return;
  try {
    // Fetch all user data in parallel (v2: also fetch agent instructions)
    const uid = encodeURIComponent(user.value.userId);
    const [filesResponse, chatsResponse, statusResponse, summaryResponse, instrResponse] = await Promise.all([
      fetch(`/api/user-files?userId=${uid}`, { credentials: 'include' }),
      fetch(`/api/user-chats?userId=${uid}`, { credentials: 'include' }),
      fetch(`/api/user-status?userId=${uid}`, { credentials: 'include' }),
      fetch(`/api/patient-summary?userId=${uid}`, { credentials: 'include' }),
      fetch('/api/agent-instructions', { credentials: 'include' }).catch(() => null)
    ]);

    const files = filesResponse.ok ? await filesResponse.json() : null;
    const savedChats = chatsResponse.ok ? await chatsResponse.json() : null;
    const status = statusResponse.ok ? await statusResponse.json() : null;
    const summary = summaryResponse.ok ? await summaryResponse.json() : null;
    const instrData = instrResponse && instrResponse.ok ? await instrResponse.json() : null;
    const filesList = Array.isArray(files?.files) ? files.files : [];
    const indexedSet = new Set(Array.isArray(files?.indexedFiles) ? files.indexedFiles : []);
    const kbName = files?.kbName || null;
    const fileStatusSummary = filesList.map((file: any) => {
      const bucketKey = file.bucketKey || '';
      const kbFolderPrefix = kbName ? `${user.value?.userId}/${kbName}/` : null;
      const inKnowledgeBase = kbFolderPrefix
        ? (file.bucketKey || '').startsWith(kbFolderPrefix)
        : false;
      let chipStatus: 'indexed' | 'pending' | 'not_in_kb' = 'not_in_kb';
      if (inKnowledgeBase && indexedSet.has(bucketKey)) {
        chipStatus = 'indexed';
      } else if (inKnowledgeBase && !indexedSet.has(bucketKey)) {
        chipStatus = 'pending';
      }
      return {
        fileName: file.fileName,
        bucketKey,
        chipStatus
      };
    });

    await saveUserSnapshot({
      user: {
        userId: user.value.userId,
        displayName: user.value.displayName,
        isTemporary: user.value.isTemporary,
        isAdmin: user.value.isAdmin
      },
      files,
      savedChats,
      currentChat: snapshot?.currentChat || null,
      currentMedications: status?.currentMedications || null,
      initialFile: status?.initialFile || null,
      fileStatusSummary,
      patientSummary: summary?.summary || null
    });

    // Also save to local folder if connected (v2 state file)
    if (localFolderHandle.value && user.value?.userId) {
      try {
        const now = new Date().toISOString();
        const indexedCount = filesList.filter((f: any) => indexedSet.has(f.bucketKey || '')).length;
        const state: MaiaState = {
          version: 2,
          userId: user.value.userId,
          displayName: user.value.displayName,
          updatedAt: now,
          exportedAt: now,
          files: filesList.map((f: any) => ({
            fileName: f.fileName,
            size: f.fileSize,
            cloudStatus: indexedSet.has(f.bucketKey || '') ? 'indexed' as const : 'pending' as const,
            bucketKey: f.bucketKey
          })),
          currentMedications: status?.currentMedications || null,
          patientSummary: summary?.summary || null,
          savedChats: savedChats || undefined,
          currentChat: snapshot?.currentChat || undefined,
          agentInstructions: instrData?.instructions || null,
          kbStats: { fileCount: indexedCount, tokenCount: files?.tokenCount || 0 },
          wizardComplete: status?.workflowStage === 'patient_summary'
        };
        await writeStateFile(localFolderHandle.value, state);

        // Update identity file lastSync
        try {
          const identity = await readIdentityFile(localFolderHandle.value);
          if (identity) {
            identity.lastSync = now;
            await writeIdentityFile(localFolderHandle.value, identity);
          }
        } catch {
          // non-critical
        }

        // Update webloc shortcut with patient name from summary
        if (summary?.summary && user.value?.userId) {
          try {
            const { writeWeblocFile } = await import('./utils/localFolder');
            // Extract patient name from first line of summary (typically "Patient Summary for <Name>")
            const firstLine = summary.summary.split('\n')[0] || '';
            const nameMatch = firstLine.match(/(?:Patient Summary for|Summary for|Name:\s*)\s*(.+)/i);
            const patientName = nameMatch?.[1]?.trim();
            if (patientName) {
              await writeWeblocFile(localFolderHandle.value, window.location.origin, {
                patientName,
                userId: user.value.userId
              });
            }
          } catch {
            // non-critical
          }
        }
      } catch (e) {
        console.warn('[localFolder] Failed to save state to local folder:', e);
      }
    }

    // Update known-user registry
    addOrUpdateKnownUser({
      userId: user.value.userId,
      displayName: user.value.displayName || user.value.userId,
      folderName: localFolderName.value || null,
      hasPasskey: !!user.value.hasPasskey,
      lastActive: new Date().toISOString()
    });
  } catch (error) {
    console.warn('Failed to save local snapshot:', error);
  }
};

/** Handle local-folder-connected event from ChatInterface. */
const handleLocalFolderConnected = async (payload: { handle: FileSystemDirectoryHandle; folderName: string }) => {
  localFolderHandle.value = payload.handle;
  localFolderName.value = payload.folderName;

  // Read or create the identity file inside the folder
  try {
    const existing = await readIdentityFile(payload.handle);
    if (existing) {
      // Folder already belongs to a user
      if (user.value?.userId && existing.userId !== user.value.userId) {
        // Identity mismatch — this folder belongs to a different user.
        // For now, log a warning; Phase 3 will add a conflict dialog.
        console.warn(`[IDENTITY] Folder "${payload.folderName}" belongs to ${existing.userId}, but current user is ${user.value.userId}`);
      }
    } else if (user.value?.userId) {
      // New folder — stamp it with the current user's identity
      const identity: MaiaIdentity = {
        userId: user.value.userId,
        displayName: user.value.displayName || user.value.userId,
        createdAt: new Date().toISOString(),
        lastSync: new Date().toISOString()
      };
      await writeIdentityFile(payload.handle, identity);
    }
  } catch (e) {
    console.warn('[localFolder] Identity file check failed:', e);
  }

  // Register in the multi-user registry
  if (user.value?.userId) {
    addOrUpdateKnownUser({
      userId: user.value.userId,
      displayName: user.value.displayName || user.value.userId,
      folderName: payload.folderName,
      hasPasskey: false,
      lastActive: new Date().toISOString()
    });
    setActiveUserId(user.value.userId);
  }
};

/** Detect whether the browser is Chrome (not Edge, not Opera). */
const isChromeBrowser = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Chrome\/\d+/.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua);
};

/** After device-privacy choice, check Chrome before proceeding. */
const proceedAfterDeviceChoice = () => {
  if (!isChromeBrowser()) {
    showNotChromeDialog.value = true;
    return;
  }
  startTemporarySession();
};

const handleContinueNonChrome = () => {
  showNotChromeDialog.value = false;
  showCreateFolderDialog.value = true;
};

const handleFolderReady = () => {
  showCreateFolderDialog.value = false;
  startTemporarySession();
};

const handlePrivateDevice = () => {
  sharedComputerMode.value = false;
  deviceChoiceResolved.value = true;
  showDevicePrivacyDialog.value = false;
  proceedAfterDeviceChoice();
};

const handleSharedDevice = () => {
  sharedComputerMode.value = true;
  deviceChoiceResolved.value = true;
  showDevicePrivacyDialog.value = false;
  showSharedDeviceWarning.value = true;
};

const handleSharedWarningOk = () => {
  showSharedDeviceWarning.value = false;
  proceedAfterDeviceChoice();
};

const handleGetStartedNoPassword = () => {
  if (typeof console !== 'undefined' && console.log) {
    console.log('[AUTH] Get Started (No Password): newClient=', isNewClient.value, 'deviceResolved=', deviceChoiceResolved.value, 'userType=', welcomeUserType.value);
  }
  // Cloud user (has passkey) → challenge passkey directly
  if (welcomeUserType.value === 'cloud') {
    const userId = welcomeDisplayUserId.value;
    passkeyPrefillUserId.value = userId || null;
    passkeyPrefillAction.value = 'signin';
    showAuth.value = true;
    return;
  }
  if (isNewClient.value) {
    if (!deviceChoiceResolved.value) {
      showDevicePrivacyDialog.value = true;
      return;
    }
    startTemporarySession();
    return;
  }
  startTemporarySession();
};

/** "sign-in with a passkey" link on Welcome page for new users */
const handlePasskeySignInLink = () => {
  passkeyPrefillUserId.value = null;
  passkeyPrefillAction.value = 'signin';
  showAuth.value = true;
};

// Passkey flow — hidden in simplified welcome page, kept for future use
/* eslint-disable @typescript-eslint/no-unused-vars */
// @ts-expect-error Intentionally unused: Passkey button hidden in simplified welcome page
const handleGetStartedPasskey = () => {
  showOtherAccountOptionsDialog.value = false;
  if (welcomeUserType.value === 'cloud' && welcomeDisplayUserId.value) {
    passkeyPrefillUserId.value = welcomeDisplayUserId.value;
    passkeyPrefillAction.value = 'signin';
  } else {
    passkeyPrefillUserId.value = null;
    passkeyPrefillAction.value = null;
  }
  showAuth.value = true;
};
/* eslint-enable @typescript-eslint/no-unused-vars */

const performSignOut = async () => {
  const response = await fetch('/api/sign-out', {
    method: 'POST',
    credentials: 'include'
  });

  if (response.ok) {
    resetAuthState();
    if (deepLinkShareId.value) {
      await checkDeepLinkSession(deepLinkShareId.value);
    }
  }
};

const handleDormantSignOut = async () => {
  if (!user.value?.userId) return;

  // If no persistent folder handle, prompt user to choose a folder for saving updated files
  if (!localFolderHandle.value && !sharedComputerMode.value) {
    showSignOutFolderPrompt.value = true;
    return;
  }

  await completeDormantSignOut();
};

/** Finish the dormant sign-out after optional folder save. */
const completeDormantSignOut = async () => {
  if (!user.value?.userId) return;
  dormantLoading.value = true;
  try {
    await saveLocalSnapshot(signOutSnapshot.value);
    await fetch('/api/account/dormant', {
      method: 'POST',
      credentials: 'include'
    });
    await performSignOut();
  } catch (error) {
    console.error('Dormant sign out error:', error);
  } finally {
    dormantLoading.value = false;
    showDormantDialog.value = false;
    signOutSnapshot.value = null;
  }
};

/** User chose to skip folder save on sign-out. */
const signOutFolderSkip = () => {
  showSignOutFolderPrompt.value = false;
  void completeDormantSignOut();
};

/** User chose to download updated state on sign-out (non-Chrome browsers only). */
const signOutFolderPick = async () => {
  signOutFolderSaving.value = true;
  try {
    await downloadStateAsFile();
  } catch (e) {
    console.warn('[sign-out] State download failed:', e);
  } finally {
    signOutFolderSaving.value = false;
    showSignOutFolderPrompt.value = false;
    void completeDormantSignOut();
  }
};

/** Download state JSON as a file (fallback for browsers without folder write). */
const downloadStateAsFile = async () => {
  if (!user.value?.userId) return;
  try {
    const [filesResponse, statusResponse, summaryResponse] = await Promise.all([
      fetch(`/api/user-files?userId=${encodeURIComponent(user.value.userId)}`, { credentials: 'include' }),
      fetch(`/api/user-status?userId=${encodeURIComponent(user.value.userId)}`, { credentials: 'include' }),
      fetch(`/api/patient-summary?userId=${encodeURIComponent(user.value.userId)}`, { credentials: 'include' })
    ]);
    const files = filesResponse.ok ? await filesResponse.json() : null;
    const status = statusResponse.ok ? await statusResponse.json() : null;
    const summary = summaryResponse.ok ? await summaryResponse.json() : null;
    const filesList = Array.isArray(files?.files) ? files.files : [];
    const indexedSet = new Set(Array.isArray(files?.indexedFiles) ? files.indexedFiles : []);
    const state = {
      version: 1,
      userId: user.value.userId,
      displayName: user.value.displayName,
      updatedAt: new Date().toISOString(),
      files: filesList.map((f: any) => ({
        fileName: f.fileName,
        size: f.fileSize,
        cloudStatus: indexedSet.has(f.bucketKey || '') ? 'indexed' : 'pending',
        bucketKey: f.bucketKey
      })),
      currentMedications: status?.currentMedications || null,
      patientSummary: summary?.summary || null
    };
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'maia-state.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn('[sign-out] Failed to download state:', e);
  }
};

const handleLiveSignOut = async () => {
  dormantLoading.value = true;
  try {
    await saveLocalSnapshot(signOutSnapshot.value);
    await performSignOut();
  } catch (error) {
    console.error('Sign out error:', error);
  } finally {
    dormantLoading.value = false;
    showDormantDialog.value = false;
    signOutSnapshot.value = null;
  }
};

const clearWizardPendingKey = (userId?: string | null) => {
  const key = userId ? `wizardKbPendingFileName-${userId}` : 'wizardKbPendingFileName';
  try {
    localStorage.removeItem(key);
  } catch (error) {
    // ignore
  }
};

/** [AUTH] RESTORE FROM LOCAL FOLDER: try local folder maia-state.json first, fall back to IndexedDB. */
const handleRestoreFromLocalFolder = async () => {
  const localId = welcomeLocalUserId.value;
  if (!localId) return;
  tempStartLoading.value = true;
  tempStartError.value = '';
  try {
    const newUser = await createTemporarySession();
    if (!newUser) return;
    // Try to read local state from folder first (has accurate file list + wizard status)
    let localState: MaiaState | null = null;
    if (localFolderHandle.value) {
      const { readStateFile } = await import('./utils/localFolder');
      localState = await readStateFile(localFolderHandle.value);
    }
    if (!localState) {
      // Fall back to IndexedDB snapshot, convert to MaiaState shape
      const snapshot = await getUserSnapshot(localId);
      if (snapshot) {
        localState = {
          version: 1,
          userId: localId,
          displayName: snapshot.user?.displayName || localId,
          updatedAt: snapshot.updatedAt || new Date().toISOString(),
          files: Array.isArray(snapshot.fileStatusSummary) ? snapshot.fileStatusSummary.map((f: any) => ({
            fileName: f.fileName,
            bucketKey: f.bucketKey,
            cloudStatus: f.chipStatus
          })) : undefined,
          currentMedications: snapshot.currentMedications || null,
          patientSummary: snapshot.patientSummary || null,
          savedChats: snapshot.savedChats || undefined,
          currentChat: snapshot.currentChat || undefined
        };
      }
    }
    if (localState) {
      restoreWizardLocalState.value = localState;
      showRestoreWizard.value = true;
    } else {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({ type: 'info', message: 'No local backup found. Use the wizard to set up your account.', timeout: 4000 });
      }
    }
  } catch (error) {
    tempStartError.value = error instanceof Error ? error.message : 'Unable to start restore';
  } finally {
    tempStartLoading.value = false;
  }
};

/** [AUTH] Open delete confirmation dialog for local userId from welcome page. */
const handleDeleteLocalUser = () => {
  showDeleteLocalUserDialog.value = true;
};

/** [AUTH] Confirmed delete: clear local snapshot and best-effort delete cloud resources. */
const confirmDeleteLocalUser = async () => {
  const localId = welcomeLocalUserId.value;
  if (!localId) return;
  deleteLocalUserLoading.value = true;
  try {
    // Best-effort server-side delete (user may have no cloud account)
    try {
      await fetch('/api/local/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: localId })
      });
    } catch {
      // Non-fatal – clear local data regardless
    }
    // Clear all local data
    await clearUserSnapshot(localId);
    clearLastSnapshotUserId();
    clearWizardPendingKey(localId);
    // Reset welcome state so GET STARTED creates a new userId
    welcomeLocalUserId.value = null;
    welcomeLocalSnapshot.value = null;
    welcomeLocalHasPasskey.value = null;
    welcomeAgentExists.value = null;
    welcomeCloudFileCount.value = null;
    welcomeStatus.value = {};
    showDeleteLocalUserDialog.value = false;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({ type: 'positive', message: `${localId} deleted. Click GET STARTED to create a new account.`, timeout: 5000 });
    }
  } catch (error) {
    console.error('[AUTH] Local user delete failed:', error);
  } finally {
    deleteLocalUserLoading.value = false;
  }
};

const handleClearLocalBackup = () => {
  clearLastSnapshotUserId();
  pendingLocalUserId.value = null;
  showMissingAgentDialog.value = false;
  startTemporarySession();
};

const handleStartWizardAgain = () => {
  clearLastSnapshotUserId();
  pendingLocalUserId.value = null;
  showMissingAgentDialog.value = false;
  startTemporarySession();
};

const handleCloudRestore = async () => {
  if (!user.value?.userId) return;
  cloudHealthLoading.value = true;
  try {
    // Try to read local state from folder first, then fall back to IndexedDB
    let localState: MaiaState | null = null;
    if (localFolderHandle.value) {
      const { readStateFile } = await import('./utils/localFolder');
      localState = await readStateFile(localFolderHandle.value);
    }
    if (!localState) {
      // Fall back to IndexedDB snapshot, convert to MaiaState shape
      const snapshot = await getUserSnapshot(user.value.userId);
      if (snapshot) {
        localState = {
          version: 1,
          userId: user.value.userId,
          displayName: user.value.displayName,
          updatedAt: snapshot.updatedAt || new Date().toISOString(),
          files: Array.isArray(snapshot.fileStatusSummary) ? snapshot.fileStatusSummary.map((f: any) => ({
            fileName: f.fileName,
            bucketKey: f.bucketKey,
            cloudStatus: f.chipStatus
          })) : undefined,
          currentMedications: snapshot.currentMedications || null,
          patientSummary: snapshot.patientSummary || null,
          savedChats: snapshot.savedChats || undefined,
          currentChat: snapshot.currentChat || undefined
        };
      }
    }
    if (!localState) {
      showCloudHealthDialog.value = false;
      cloudHealthDetails.value = null;
      if ($q && typeof $q.notify === 'function') {
        $q.notify({ type: 'warning', message: 'No local backup found. You may need to re-upload your files.', timeout: 5000 });
      }
      return;
    }
    // Launch the Restore Wizard
    restoreWizardLocalState.value = localState;
    showCloudHealthDialog.value = false;
    showRestoreWizard.value = true;
  } catch (e) {
    console.error('[cloud-health] Restore failed:', e);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({ type: 'negative', message: 'Restore failed: ' + (e instanceof Error ? e.message : String(e)), timeout: 5000 });
    }
  } finally {
    cloudHealthLoading.value = false;
  }
};

const handleCloudStartFresh = async () => {
  if (!user.value?.userId) return;
  cloudHealthLoading.value = true;
  try {
    const uid = user.value.userId;
    await clearUserSnapshot(uid);
    await clearDirectoryHandle(uid);
    clearLastSnapshotUserId();
    showCloudHealthDialog.value = false;
    cloudHealthDetails.value = null;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'info',
        message: 'Local backup cleared. Starting fresh.',
        timeout: 3000
      });
    }
  } catch (e) {
    console.error('[cloud-health] Start fresh failed:', e);
  } finally {
    cloudHealthLoading.value = false;
  }
};

/** Phase 7: Restore Wizard completed — close dialog, clear health state, notify user. */
const handleRestoreWizardComplete = () => {
  showRestoreWizard.value = false;
  restoreWizardLocalState.value = null;
  cloudHealthDetails.value = null;
  suppressWizard.value = true; // Don't re-enter the wizard flow
  if ($q && typeof $q.notify === 'function') {
    $q.notify({ type: 'positive', message: 'Account restored successfully!', timeout: 3000 });
  }
};

/** Handle "Restore" from destroyed account dialog — recreate user doc then launch RestoreWizard */
const handleDestroyedRestore = async () => {
  const uid = destroyedUserId.value;
  if (!uid) return;
  cloudHealthLoading.value = true;
  try {
    // Step 1: Recreate the user doc in CouchDB
    const recreateResp = await fetch('/api/account/recreate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: uid })
    });
    const recreateData = await recreateResp.json();
    if (!recreateResp.ok || !recreateData.authenticated) {
      throw new Error(recreateData.error || 'Failed to recreate account');
    }
    // Sign in with the recreated user
    setAuthenticatedUser(recreateData.user, null);
    showDestroyedRestoreDialog.value = false;

    // Step 2: Read local state from folder or IndexedDB
    let localState: MaiaState | null = null;
    if (localFolderHandle.value) {
      const { readStateFile } = await import('./utils/localFolder');
      localState = await readStateFile(localFolderHandle.value);
    }
    if (!localState) {
      const snapshot = await getUserSnapshot(uid);
      if (snapshot) {
        localState = {
          version: 1,
          userId: uid,
          displayName: recreateData.user?.displayName || uid,
          updatedAt: snapshot.updatedAt || new Date().toISOString(),
          files: Array.isArray(snapshot.fileStatusSummary) ? snapshot.fileStatusSummary.map((f: any) => ({
            fileName: f.fileName,
            bucketKey: f.bucketKey,
            cloudStatus: f.chipStatus
          })) : undefined,
          currentMedications: snapshot.currentMedications || null,
          patientSummary: snapshot.patientSummary || null,
          savedChats: snapshot.savedChats || undefined,
          currentChat: snapshot.currentChat || undefined
        };
      }
    }

    // Step 3: Check cloud health (everything should be missing)
    const healthResp = await fetch(
      `/api/cloud-health?userId=${encodeURIComponent(uid)}`,
      { credentials: 'include' }
    );
    if (healthResp.ok) {
      const health = await healthResp.json();
      cloudHealthDetails.value = health.details || {
        database: { ok: true },
        agent: { ok: false, error: 'Not deployed' },
        knowledgeBase: { ok: false, error: 'Not created' },
        spacesFiles: { ok: false, error: 'No files' }
      };
    }

    // Step 4: Launch the Restore Wizard
    if (localState) {
      restoreWizardLocalState.value = localState;
      showRestoreWizard.value = true;
    } else {
      // No local state — just notify, they'll need to re-upload manually
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'warning',
          message: 'Account recreated but no local backup found. Please re-upload your files.',
          timeout: 5000
        });
      }
    }
  } catch (e) {
    console.error('[DESTROYED-RESTORE] Error:', e);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({ type: 'negative', message: 'Restore failed: ' + (e instanceof Error ? e.message : String(e)), timeout: 5000 });
    }
  } finally {
    cloudHealthLoading.value = false;
  }
};

/** Handle "Start Fresh" from destroyed account dialog — clear cookie and create new account */
const handleDestroyedStartFresh = async () => {
  showDestroyedRestoreDialog.value = false;
  destroyedUserId.value = null;
  tempStartLoading.value = true;
  try {
    const response = await fetch('/api/temporary/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ forceNew: true })
    });
    const data = await response.json();
    if (data.authenticated && data.user) {
      setAuthenticatedUser(data.user, null);
    }
  } catch (e) {
    console.error('[DESTROYED-FRESH] Error:', e);
  } finally {
    tempStartLoading.value = false;
  }
};

const restoreSavedChats = async (snapshot: any) => {
  const savedChats = snapshot?.savedChats?.chats;
  if (!Array.isArray(savedChats) || savedChats.length === 0) return;

  for (const chat of savedChats) {
    try {
      await fetch('/api/save-group-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          chatHistory: chat.chatHistory || [],
          uploadedFiles: chat.uploadedFiles || [],
          connectedKB: chat.connectedKB || 'No KB connected'
        })
      });
    } catch (error) {
      console.warn('Failed to restore saved chat:', error);
    }
  }
};

const createTemporarySession = async () => {
  const response = await fetch('/api/temporary/start', {
    method: 'POST',
    credentials: 'include'
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Unable to create temporary account');
  }
  if (data.requiresPasskey && data.user) {
    tempStartError.value = `A passkey already exists for ${data.user.userId}. Please use Passkey instead.`;
    passkeyPrefillUserId.value = data.user.userId;
    passkeyPrefillAction.value = 'signin';
    showAuth.value = true;
    return null;
  }
  // Account was destroyed but cookie still exists — offer restore from local folder
  if (data.destroyed && data.destroyedUserId) {
    destroyedUserId.value = data.destroyedUserId;
    showDestroyedRestoreDialog.value = true;
    tempStartLoading.value = false;
    return null;
  }
  if (!data.authenticated || !data.user) {
    throw new Error(data.error || 'Unable to create temporary account');
  }
  setAuthenticatedUser(data.user, null);
  return data.user;
};

const handleRestoreSnapshot = async () => {
  if (!restoreSnapshot.value || !user.value?.userId) return;
  restoreLoading.value = true;
  console.log('[SAVE-RESTORE] Starting restore snapshot', {
    userId: user.value.userId,
    snapshotUserId: restoreSnapshot.value?.user?.userId || null
  });
  try {
    const snapshot = restoreSnapshot.value;
    const snapshotFiles = Array.isArray(snapshot?.files?.files) ? snapshot.files.files : [];
    const statusSummary = Array.isArray(snapshot?.fileStatusSummary) ? snapshot.fileStatusSummary : [];
    const snapshotKbName = snapshot?.files?.kbName || null;
    const initialFromSnapshot = snapshot?.initialFile || null;
    if (statusSummary.length > 0) {
      rehydrationFiles.value = statusSummary.map((entry: any) => ({
        bucketKey: entry.bucketKey,
        fileName: entry.fileName,
        chipStatus: entry.chipStatus,
        kbName: snapshotKbName
      }));
    } else if (snapshotFiles.length === 0 && Array.isArray(snapshot?.files?.indexedFiles)) {
      rehydrationFiles.value = snapshot.files.indexedFiles.map((bucketKey: string) => ({
        bucketKey,
        fileName: bucketKey.split('/').pop(),
        chipStatus: 'indexed',
        kbName: snapshotKbName
      }));
    } else {
      rehydrationFiles.value = snapshotFiles.map((entry: any) => ({
        bucketKey: entry.bucketKey,
        fileName: entry.fileName,
        chipStatus: 'not_in_kb',
        kbName: snapshotKbName
      }));
    }
    console.log('[SAVE-RESTORE] Rehydration files prepared', {
      count: rehydrationFiles.value.length,
      initialFile: initialFromSnapshot?.fileName || initialFromSnapshot?.bucketKey || null
    });
    if (initialFromSnapshot && (initialFromSnapshot.bucketKey || initialFromSnapshot.fileName)) {
      const existing = rehydrationFiles.value.find(item =>
        (initialFromSnapshot.bucketKey && item.bucketKey === initialFromSnapshot.bucketKey) ||
        (initialFromSnapshot.fileName && item.fileName === initialFromSnapshot.fileName)
      );
      if (!existing) {
        rehydrationFiles.value.unshift({
          bucketKey: initialFromSnapshot.bucketKey,
          fileName: initialFromSnapshot.fileName,
          chipStatus: 'not_in_kb',
          kbName: snapshotKbName,
          isInitial: true
        });
      } else {
        existing.isInitial = true;
        rehydrationFiles.value = [
          existing,
          ...rehydrationFiles.value.filter(item => item !== existing)
        ];
      }
    }
    rehydrationActive.value = rehydrationFiles.value.length > 0;
    suppressWizard.value = false;
    console.log('[SAVE-RESTORE] Rehydration state set', {
      active: rehydrationActive.value,
      count: rehydrationFiles.value.length
    });
    if (rehydrationActive.value) {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'info',
          message: 'Restore in progress: re-upload your files in Saved Files.',
          timeout: 5000
        });
      }
    }
    restoredChatState.value = restoreSnapshot.value.currentChat || null;
    await restoreSavedChats(restoreSnapshot.value);
    console.log('[SAVE-RESTORE] Saved chats restored', {
      userId: user.value.userId
    });
    if (restoreSnapshot.value.currentMedications) {
      try {
        await fetch('/api/user-current-medications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: user.value.userId,
            currentMedications: restoreSnapshot.value.currentMedications
          })
        });
        console.log('[SAVE-RESTORE] Current medications restored', {
          userId: user.value.userId
        });
      } catch (medsError) {
        console.warn('Failed to restore current medications:', medsError);
      }
    }
    if (restoreSnapshot.value.patientSummary) {
      try {
        await fetch('/api/patient-summary', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: user.value.userId,
            summary: restoreSnapshot.value.patientSummary
          })
        });
        console.log('[SAVE-RESTORE] Patient summary restored', {
          userId: user.value.userId
        });
      } catch (summaryError) {
        console.warn('Failed to restore patient summary:', summaryError);
      }
    }
    clearLastSnapshotUserId();
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Local backup restored to your new temporary account.',
        timeout: 4000
      });
    }
  } catch (error) {
    console.error('Restore failed:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'Failed to restore local backup.',
        timeout: 4000
      });
    }
  } finally {
    restoreLoading.value = false;
    showRestoreDialog.value = false;
    console.log('[SAVE-RESTORE] Restore flow finished', {
      userId: user.value?.userId || null,
      rehydrationActive: rehydrationActive.value,
      rehydrationCount: rehydrationFiles.value.length
    });
  }
};

const handleSkipRestore = () => {
  showRestoreDialog.value = false;
  restoreSnapshot.value = null;
  suppressWizard.value = false;
};

const handleRehydrationComplete = (_payload: { hasInitialFile: boolean }) => {
  rehydrationActive.value = false;
  suppressWizard.value = false;
  console.log('[SAVE-RESTORE] Rehydration complete', {
    userId: user.value?.userId || null
  });
};

const handleRehydrationFileRemoved = (payload: { bucketKey?: string; fileName?: string }) => {
  if (!payload) return;
  const name = payload.fileName || (payload.bucketKey ? payload.bucketKey.split('/').pop() : null);
  if (!name) return;
  const entry = rehydrationFiles.value.find(e => {
    const entryName = e.fileName || (e.bucketKey ? e.bucketKey.split('/').pop() : null);
    return entryName === name;
  });
  if (entry) {
    entry.restored = true;
    rehydrationFiles.value = [...rehydrationFiles.value];
  }
  console.log('[SAVE-RESTORE] Rehydration file marked restored', {
    userId: user.value?.userId || null,
    fileName: name,
    restoredCount: rehydrationFiles.value.filter(e => e.restored).length,
    total: rehydrationFiles.value.length
  });
};

const checkDeepLinkSession = async (shareId: string) => {
  deepLinkLoading.value = true;
  deepLinkError.value = '';

  try {
    const response = await fetch(`/api/deep-link/session?shareId=${encodeURIComponent(shareId)}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(response.statusText || 'Failed to verify deep link');
    }

    const result = await response.json();

    if (result.authenticated && result.user) {
      const info: DeepLinkInfo | null = result.deepLinkInfo || (result.deepLink
        ? { shareId, chatId: result.deepLinkInfo?.chatId || null }
        : { shareId, chatId: result.deepLinkInfo?.chatId || null });
      setAuthenticatedUser({ ...result.user, isDeepLink: !!result.deepLink }, info);
      showDeepLinkAccess.value = false;
    } else {
      showDeepLinkAccess.value = true;
    }
  } catch (error) {
    deepLinkError.value = error instanceof Error ? error.message : 'Unable to load invitation';
    showDeepLinkAccess.value = true;
  } finally {
    deepLinkLoading.value = false;
  }
};

const handleSignOut = async (snapshot?: SignOutSnapshot) => {
  signOutSnapshot.value = snapshot || null;
  if (user.value?.isTemporary) {
    showTempSignOutDialog.value = true;
    return;
  }
  try {
    const response = await fetch('/api/user-deep-links', {
      credentials: 'include'
    });
    const data = response.ok ? await response.json() : null;
    const deepLinkCount = data?.count || 0;
    dormantDeepLinkCount.value = deepLinkCount;
    if (deepLinkCount > 0) {
      showDormantDialog.value = true;
      return;
    }
  } catch (error) {
    console.warn('Unable to check deep links for sign-out:', error);
  }

  const hasLocalBackup = getLastSnapshotUserId() === user.value?.userId;
  if (!hasLocalBackup && !getPasskeyBackupPromptSkip()) {
    passkeyBackupDoNotAskAgain.value = false;
    showPasskeyBackupPromptModal.value = true;
    return;
  }
  await handleDormantSignOut();
};

const onPasskeyBackupNo = () => {
  if (passkeyBackupDoNotAskAgain.value) {
    setPasskeyBackupPromptSkip(true);
  }
  showPasskeyBackupPromptModal.value = false;
  void handleDormantSignOut();
};

// onPasskeyBackupYes removed — backup prompt replaced with info-only modal

const closePasskeyBackupPinDialog = () => {
  showPasskeyBackupPinDialog.value = false;
  passkeyBackupPin.value = '';
  passkeyBackupPinError.value = '';
  passkeyBackupPinLoading.value = false;
  void handleDormantSignOut();
};

const buildSnapshotPayloadForUser = async (): Promise<{
  user: { userId: string; displayName?: string; isTemporary?: boolean; isAdmin?: boolean };
  files: any;
  savedChats: any;
  currentChat: any;
  currentMedications: any;
  initialFile: any;
  fileStatusSummary: any[];
  patientSummary: any;
} | null> => {
  if (!user.value?.userId) return null;
  const [filesResponse, chatsResponse, statusResponse, summaryResponse] = await Promise.all([
    fetch(`/api/user-files?userId=${encodeURIComponent(user.value.userId)}`, { credentials: 'include' }),
    fetch(`/api/user-chats?userId=${encodeURIComponent(user.value.userId)}`, { credentials: 'include' }),
    fetch(`/api/user-status?userId=${encodeURIComponent(user.value.userId)}`, { credentials: 'include' }),
    fetch(`/api/patient-summary?userId=${encodeURIComponent(user.value.userId)}`, { credentials: 'include' })
  ]);
  const files = filesResponse.ok ? await filesResponse.json() : null;
  const savedChats = chatsResponse.ok ? await chatsResponse.json() : null;
  const status = statusResponse.ok ? await statusResponse.json() : null;
  const summary = summaryResponse.ok ? await summaryResponse.json() : null;
  const filesList = Array.isArray(files?.files) ? files.files : [];
  const indexedSet = new Set(Array.isArray(files?.indexedFiles) ? files.indexedFiles : []);
  const kbName = files?.kbName || null;
  const fileStatusSummary = filesList.map((file: any) => {
    const bucketKey = file.bucketKey || '';
    const kbFolderPrefix = kbName ? `${user.value?.userId}/${kbName}/` : null;
    const inKnowledgeBase = kbFolderPrefix ? (file.bucketKey || '').startsWith(kbFolderPrefix) : false;
    let chipStatus: 'indexed' | 'pending' | 'not_in_kb' = 'not_in_kb';
    if (inKnowledgeBase && indexedSet.has(bucketKey)) chipStatus = 'indexed';
    else if (inKnowledgeBase && !indexedSet.has(bucketKey)) chipStatus = 'pending';
    return { fileName: file.fileName, bucketKey, chipStatus };
  });
  return {
    user: {
      userId: user.value.userId,
      displayName: user.value.displayName,
      isTemporary: user.value.isTemporary,
      isAdmin: user.value.isAdmin
    },
    files,
    savedChats,
    currentChat: signOutSnapshot.value?.currentChat || null,
    currentMedications: status?.currentMedications || null,
    initialFile: status?.initialFile || null,
    fileStatusSummary,
    patientSummary: summary?.summary || null
  };
};

const submitPasskeyBackupPin = async () => {
  const pin = (passkeyBackupPin.value || '').trim();
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    passkeyBackupPinError.value = 'Enter a 4-digit PIN';
    return;
  }
  passkeyBackupPinError.value = '';
  passkeyBackupPinLoading.value = true;
  try {
    const payload = await buildSnapshotPayloadForUser();
    if (!payload) throw new Error('Could not build backup');
    await saveUserSnapshotEncrypted(payload, pin);
    showPasskeyBackupPinDialog.value = false;
    passkeyBackupPin.value = '';
    passkeyBackupPinError.value = '';
    passkeyBackupPinLoading.value = false;
    await handleDormantSignOut();
  } catch (e) {
    passkeyBackupPinError.value = e instanceof Error ? e.message : 'Failed to save encrypted backup';
    passkeyBackupPinLoading.value = false;
  }
};

const handleTemporarySignOut = async () => {
  showTempSignOutDialog.value = false;
  await handleDormantSignOut();
};

const startTemporarySession = async () => {
  tempStartLoading.value = true;
  tempStartError.value = '';
  try {
    // Use the selected user from multi-user selector, fall back to old key
    const lastSnapshotUserId = selectedWelcomeUserId.value || getLastSnapshotUserId();
    if (lastSnapshotUserId) {
      // If the stored user has a passkey, guide them to sign in instead of restoring as temporary
      try {
        const checkResponse = await fetch(`/api/passkey/check-user?userId=${encodeURIComponent(lastSnapshotUserId)}`, {
          credentials: 'include'
        });
        if (checkResponse.ok) {
          const checkData = await checkResponse.json();
          if (checkData.exists && checkData.hasPasskey) {
            passkeyPrefillUserId.value = lastSnapshotUserId;
            passkeyPrefillAction.value = 'signin';
            welcomeBackPasskeyUserId.value = lastSnapshotUserId;
            showAuth.value = true;
            return;
          }
        }
      } catch (_) {
        // If check fails, continue with restore flow
      }

      const agentResponse = await fetch(`/api/agent-exists?userId=${encodeURIComponent(lastSnapshotUserId)}`);
      const agentData = agentResponse.ok ? await agentResponse.json() : null;
      if (agentData && agentData.exists) {
        const restoreResponse = await fetch('/api/temporary/restore', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({ userId: lastSnapshotUserId })
        });
        const restoreData = await restoreResponse.json();
        if (restoreResponse.ok && restoreData.authenticated && restoreData.user) {
          setAuthenticatedUser(restoreData.user, null);
        } else {
          throw new Error(restoreData.error || 'Unable to restore temporary account');
        }
      } else if (agentResponse.ok) {
        pendingLocalUserId.value = lastSnapshotUserId;
        missingAgentUserId.value = lastSnapshotUserId;
        showMissingAgentDialog.value = true;
        tempStartLoading.value = false;
        return;
      }
    } else {
      // Phase 4: If known users exist, confirm before creating a new account
      if (knownUsers.value.length > 0) {
        const names = knownUsers.value.map(u => u.displayName).join(', ');
        newAccountConfirmMessage.value = `You already have account(s) on this device (${names}). Create a new account for a different family member?`;
        showNewAccountConfirmDialog.value = true;
        pendingNewAccountCallback.value = async () => {
          const newUser = await createTemporarySession();
          if (!newUser) return;
          tempStartLoading.value = false;
        };
        tempStartLoading.value = false;
        return;
      }
      const newUser = await createTemporarySession();
      if (!newUser) return;
    }

    const effectiveUserId = user.value?.userId;
    if (lastSnapshotUserId && lastSnapshotUserId === effectiveUserId) {
      // Skip restore dialog if cloud is already valid (agent + spaces in sync)
      if (welcomeCloudValid.value !== true) {
        try {
          const snapshot = await getUserSnapshot(lastSnapshotUserId);
          if (snapshot) {
            restoreSnapshot.value = snapshot;
            showRestoreDialog.value = true;
            suppressWizard.value = true;
            clearWizardPendingKey(lastSnapshotUserId);
            clearWizardPendingKey(effectiveUserId);
          }
        } catch (restoreError) {
          console.warn('Unable to read local backup:', restoreError);
        }
      } else {
        console.log('[AUTH] Cloud valid – skipping restore dialog for', effectiveUserId);
      }
    }

    if (sharedComputerMode.value && user.value?.userId) {
      await startPasskeyRegistration();
    }
  } catch (error) {
    tempStartError.value = error instanceof Error ? error.message : 'Unable to create temporary account';
  } finally {
    tempStartLoading.value = false;
  }
};

const openDestroyDialog = () => {
  showTempSignOutDialog.value = false;
  destroyConfirm.value = '';
  showDestroyDialog.value = true;
};

const startPasskeyRegistration = async () => {
  if (!user.value?.userId) return;
  passkeyPrefillUserId.value = user.value.userId;
  passkeyPrefillAction.value = 'register';
  try {
    const checkResponse = await fetch(`/api/passkey/check-user?userId=${encodeURIComponent(user.value.userId)}`, {
      credentials: 'include'
    });
    if (checkResponse.ok) {
      const checkData = await checkResponse.json();
      if (checkData.exists && checkData.hasPasskey && !checkData.isAdminUser) {
        passkeyPrefillAction.value = 'signin';
      }
    }
  } catch (error) {
    // If check fails, default to registration
  }
  showTempSignOutDialog.value = false;
  showPasskeyDialog.value = true;
};

const destroyTemporaryAccount = async () => {
  if (!user.value?.userId || destroyConfirm.value !== user.value.userId) {
    return;
  }
  destroyLoading.value = true;
  const userIdToDelete = user.value.userId;
  try {
    const response = await fetch('/api/self/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({ userId: userIdToDelete })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to delete temporary account');
    }
    await clearUserSnapshot(userIdToDelete);
    removeKnownUser(userIdToDelete);
    knownUsers.value = knownUsers.value.filter(u => u.userId !== userIdToDelete);
    resetAuthState();
    showDestroyDialog.value = false;
  } catch (error) {
    console.error('Temporary account deletion error:', error);
  } finally {
    destroyLoading.value = false;
  }
};

const handleDeepLinkInfoUpdate = (info: DeepLinkInfo | null) => {
  if (info?.shareId) {
    deepLinkShareId.value = info.shareId;
  }
  deepLinkInfo.value = info;
};

const loadWelcomeCaption = async () => {
  try {
    const response = await fetch('/api/welcome-caption', {
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      welcomeCaption.value = data.caption || '';
    } else {
      console.warn('Failed to load welcome caption:', response.statusText);
      // Fallback to empty string - will show "Loading..." in template
    }
  } catch (error) {
    console.error('Error loading welcome caption:', error);
    // Fallback to empty string - will show "Loading..." in template
  }
};

const hydrateDeepLinkSession = async (share: string) => {
  try {
    const sessionResponse = await fetch(`/api/deep-link/session?shareId=${encodeURIComponent(share)}`, {
      credentials: 'include'
    });
    if (sessionResponse.ok) {
      const sessionResult = await sessionResponse.json();
      if (sessionResult.authenticated && sessionResult.user) {
        setAuthenticatedUser(
          { ...sessionResult.user, isDeepLink: !!sessionResult.deepLink, deepLinkInfo: sessionResult.deepLinkInfo || null },
          sessionResult.deepLinkInfo || { shareId: share, chatId: null }
        );
        return true;
      }
    }
  } catch (sessionError) {
    console.warn('Unable to hydrate deep-link session:', sessionError);
  }
  return false;
};

if (typeof document !== 'undefined') {
  document.title = DEFAULT_TITLE;
}

// Phase 6: beforeunload warning for non-Chrome browsers with unsaved changes
const beforeUnloadHandler = (e: BeforeUnloadEvent) => {
  if (authenticated.value && sessionDirty.value && folderAccessTier.value !== 'chrome') {
    e.preventDefault();
    e.returnValue = '';
  }
};

onMounted(async () => {
  // Migrate single-user localStorage to multi-user registry (one-time)
  migrateToKnownUsers();

  // Phase 6: Register beforeunload listener
  window.addEventListener('beforeunload', beforeUnloadHandler);

  // Load welcome caption
  loadWelcomeCaption();
  
  // Check for admin page route
  const isAdminPage = window.location.pathname === '/admin';
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  
  if (isAdminPage) {
    // If running locally, allow admin page without authentication
    if (isLocalhost) {
      showAdminPage.value = true;
      authenticated.value = true;
      return;
    }
    // Non-localhost: require passkey authentication for admin
    // (showAdminPage will be set to true in handleAuthenticated after successful admin auth)
    try {
      const adminRes = await fetch('/api/admin-username');
      if (adminRes.ok) {
        const adminData = await adminRes.json();
        passkeyPrefillUserId.value = adminData.adminUsername || null;
      }
    } catch { /* ignore */ }
    passkeyPrefillAction.value = 'signin';
    showAuth.value = true;
    return;
  }
  
  const params = new URLSearchParams(window.location.search);
  
  // Check for Current Medications editor deep link
  const editMedicationsToken = params.get('editMedications');
  const editMedicationsUserId = params.get('userId');
  
  // Store for later use after authentication
  if (editMedicationsToken && editMedicationsUserId) {
    // Store in sessionStorage for later retrieval after authentication
    sessionStorage.setItem('pendingMedicationsEdit', JSON.stringify({
      token: editMedicationsToken,
      userId: editMedicationsUserId
    }));
    
    // Remove from URL to clean it up
    params.delete('editMedications');
    params.delete('userId');
    const newSearch = params.toString();
    const newUrl = newSearch 
      ? `${window.location.pathname}?${newSearch}${window.location.hash}`
      : `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, '', newUrl);
  }
  
  let share: string | null = null;
  const queryShare = params.get('share');
  if (queryShare) {
    share = queryShare;
  } else {
    const pathMatch = window.location.pathname.match(/\/chat\/(.+)$/);
    if (pathMatch && pathMatch[1]) {
      share = pathMatch[1];
      const newUrl = `${window.location.origin}/?share=${encodeURIComponent(share)}${window.location.hash}`;
      window.history.replaceState({}, '', newUrl);
    }
  }

  // Check if user is already authenticated
  try {
    const response = await fetch('/api/current-user', {
      credentials: 'include'
    });
    const data = await response.json();
    
    if (data.authenticated) {
      const info: DeepLinkInfo | null = data.user?.deepLinkInfo
        ? {
            shareId: data.user.deepLinkInfo.activeShareId || share || (Array.isArray(data.user.deepLinkInfo.shareIds) ? data.user.deepLinkInfo.shareIds[0] : null) || null,
            chatId: data.user.deepLinkInfo.chatId || null
          }
        : (share ? { shareId: share, chatId: null } : null);
      setAuthenticatedUser(data.user, info);
      if (info?.shareId && window.location.search.indexOf(`share=${info.shareId}`) === -1) {
        const normalizedUrl = `${window.location.origin}/?share=${encodeURIComponent(info.shareId)}${window.location.hash}`;
        window.history.replaceState({}, '', normalizedUrl);
      }
      // If user is already authenticated and we have a pending medications edit, 
      // it will be handled in ChatInterface's onMounted
      return;
    }
  } catch (error) {
    console.error('Auth check error:', error);
  }

  if (!share) {
    await loadWelcomeStatus();
    // Auto-launch for returning cookie users — skip welcome page
    if (welcomeStatus.value.tempCookieUserId) {
      startTemporarySession();
      return;
    }
  }

  if (share) {
    deepLinkShareId.value = share;
    const sessionHydrated = await hydrateDeepLinkSession(share);
    if (sessionHydrated) {
      return;
    }
    showDeepLinkAccess.value = true;
    await checkDeepLinkSession(share);
  }
  
  // Watch for route changes
  const checkRoute = () => {
    const path = window.location.pathname;
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    // Only show admin page if:
    // 1. Path is /admin AND
    // 2. (Running locally OR user is authenticated and we'll let backend handle admin auth)
    if (path === '/admin') {
      if (isLocalhost) {
        showAdminPage.value = true;
      } else if (authenticated.value && user.value?.isAdmin) {
        showAdminPage.value = true;
      } else {
        showAdminPage.value = false;
      }
    } else {
      if (authenticated.value && user.value?.isAdmin) {
        showAdminPage.value = true;
        window.history.replaceState({}, '', '/admin');
      } else {
        showAdminPage.value = false;
      }
    }
  };
  
  // Store reference for cleanup before setting up listeners
  checkRouteRef.value = checkRoute;
  
  // Check route on mount and when it changes
  checkRoute();
  window.addEventListener('popstate', checkRoute);
  
  // Use a more reasonable interval for route checking (1 second instead of 100ms)
  // This reduces performance impact while still catching programmatic navigation
  routeCheckInterval.value = setInterval(checkRoute, 1000);
});
</script>

<style>
.q-layout {
  padding: 0 !important;
}

.q-page-container {
  padding: 0 !important;
}

.q-page {
  padding: 0 !important;
}

.welcome-caption {
  background-color: #f5f5f5;
  border-radius: 4px;
  column-count: 2;
  column-gap: 24px;
  column-fill: balance;
}

.welcome-caption hr:last-child {
  display: none;
}

.more-choices-card .more-choices-actions .q-btn {
  min-height: 44px;
}

@media (max-width: 768px) {
  .welcome-caption {
    column-count: 1;
  }
}
</style>

