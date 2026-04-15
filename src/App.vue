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
                <!-- Account status cards derived from IndexedDB + .webloc -->
                <div v-if="discoveredUsers.length > 0" class="q-mb-md">
                  <div
                    v-for="du in discoveredUsers"
                    :key="du.userId"
                    class="q-mb-xs q-pa-sm rounded-borders"
                    :style="{
                      border: '1px solid ' + (welcomeUserCloudStatus[du.userId] === 'ready' ? '#c8e6c9' : welcomeUserCloudStatus[du.userId] === 'loading' ? '#e0e0e0' : '#ffe0b2'),
                      background: welcomeUserCloudStatus[du.userId] === 'ready' ? '#f1f8e9' : welcomeUserCloudStatus[du.userId] === 'loading' ? '#fafafa' : '#fff8e1'
                    }"
                  >
                    <div class="row items-center no-wrap">
                      <q-icon
                        :name="welcomeUserCloudStatus[du.userId] === 'ready' ? 'check_circle' : welcomeUserCloudStatus[du.userId] === 'loading' ? 'hourglass_empty' : 'warning'"
                        :color="welcomeUserCloudStatus[du.userId] === 'ready' ? 'green' : welcomeUserCloudStatus[du.userId] === 'loading' ? 'grey' : 'orange'"
                        size="sm"
                        class="q-mr-sm"
                      />
                      <div class="col text-body2">
                        <strong>{{ du.displayName }}</strong>
                        <span v-if="du.displayName.toLowerCase() !== du.userId.toLowerCase()" class="text-grey-7"> ({{ du.userId }})</span>
                        <span v-if="du.folderName" class="text-grey-6"> &mdash; {{ du.folderName }}</span>
                        <div v-if="welcomeUserCloudStatus[du.userId] === 'ready'" class="text-caption text-green-8">
                          Cloud account ready
                        </div>
                        <div v-else-if="welcomeUserCloudStatus[du.userId] === 'loading'" class="text-caption text-grey-6">
                          Checking account...
                        </div>
                        <div v-else class="text-caption text-orange-9">
                          Cloud account needs restoring
                        </div>
                      </div>
                      <div class="row no-wrap q-gutter-xs">
                        <q-btn
                          v-if="welcomeUserCloudStatus[du.userId] === 'ready'"
                          flat dense size="xs" color="green-8" label="GET STARTED"
                          @click="handleGetStartedForUser(du)"
                        >
                          <q-tooltip>Sign in and continue</q-tooltip>
                        </q-btn>
                        <q-btn
                          v-else-if="welcomeUserCloudStatus[du.userId] === 'restore'"
                          flat dense size="xs" color="orange-9" label="RESTORE"
                          @click="handleUserCardRestore(du)"
                        >
                          <q-tooltip>Restore cloud account from local backup</q-tooltip>
                        </q-btn>
                        <q-btn
                          flat dense round size="xs" icon="close" color="grey-5"
                          @click="handleDeleteUser(du.userId)"
                        >
                          <q-tooltip>Delete account completely</q-tooltip>
                        </q-btn>
                      </div>
                    </div>
                  </div>
                  <div class="text-center q-mt-xs">
                    <q-btn flat dense size="sm" color="grey-6" icon="person_add" label="Add family member" @click="handleAddFamilyMember" />
                  </div>
                </div>
                <!-- No discovered users: passkey link -->
                <div v-else class="text-center q-mb-md">
                  <p class="q-ma-none text-body2" style="color: #1a1a1a">
                    Get started with a new account or
                    <a
                      href="#"
                      style="color: #1976d2; text-decoration: underline; cursor: pointer"
                      @click.prevent="handlePasskeySignInLink"
                    >sign-in with a passkey</a>.
                  </p>
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

                  <!-- Introduction from welcome.md -->
                  <div class="q-mt-lg">
                    <div class="welcome-intro text-body2 text-grey-8 q-pa-md">
                      <vue-markdown :source="welcomeIntro || 'Loading...'" />
                    </div>
                  </div>

                  <!-- Footer: Privacy | User Guide | FAQ | About + copyright -->
                  <div class="text-center q-mt-lg q-mb-md">
                    <a href="/privacy.html" target="_blank" class="welcome-footer-link">Privacy</a>
                    <span class="text-grey-5 q-mx-sm">|</span>
                    <a href="/User_Guide.html" target="_blank" class="welcome-footer-link">User Guide</a>
                    <span class="text-grey-5 q-mx-sm">|</span>
                    <a href="/faq.html" target="_blank" class="welcome-footer-link">FAQ</a>
                    <span class="text-grey-5 q-mx-sm">|</span>
                    <a href="/about.html" target="_blank" class="welcome-footer-link">About</a>
                    <div class="text-caption text-grey-6 q-mt-sm">CC-BY MAIA v{{ appVersion }} by Adrian Gropper, MD</div>
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
            ref="chatInterfaceRef"
            :user="user"
            :is-deep-link-user="isDeepLinkUser"
            :deep-link-info="deepLinkInfo"
            :restore-chat-state="restoredChatState"
            :rehydration-files="rehydrationFiles"
            :rehydration-active="rehydrationActive"
            :restore-active="showRestoreWizard"
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
            @wizard-complete="handleWizardComplete"
            @test-setup-complete="handleTestSetupComplete"
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

    <!-- Get Started choice dialog — shown when restorable users exist -->
    <q-dialog v-model="showGetStartedChoiceDialog" persistent>
      <q-card style="min-width: 460px; max-width: 600px">
        <q-card-section>
          <div class="text-h6">What would you like to do?</div>
          <div class="text-body2 text-grey-7 q-mt-xs">
            You have saved accounts on this device.
          </div>
        </q-card-section>
        <q-card-section class="q-pt-none q-gutter-sm" style="display: flex; flex-direction: column;">
          <q-btn
            v-for="ku in restorableUsers"
            :key="ku.userId"
            unelevated
            color="primary"
            class="full-width"
            :label="'Restore ' + ku.displayName"
            :loading="tempStartLoading && selectedWelcomeUserId === ku.userId"
            @click="showGetStartedChoiceDialog = false; handleUserCardRestore(ku)"
          />
          <q-btn
            outline
            color="primary"
            class="full-width"
            label="Add a new family member"
            @click="showGetStartedChoiceDialog = false; handleAddFamilyMember()"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" color="grey-7" @click="showGetStartedChoiceDialog = false" />
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
            Use <strong>DELETE CLOUD ACCOUNT</strong> only if you want to permanently delete your cloud data.
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
          <q-btn flat label="DELETE CLOUD ACCOUNT" color="negative" @click="openDestroyDialog" />
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

    <!-- Delete local user confirmation dialog (from welcome page) -->
    <q-dialog v-model="showDeleteLocalUserDialog" persistent>
      <q-card style="min-width: 420px; max-width: 540px">
        <q-card-section>
          <div class="text-h6">Delete {{ welcomeDisplayUserId }}?</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            This will permanently delete all data for <strong>{{ welcomeDisplayUserId }}</strong>:
            cloud account (files, knowledge base, agent) and local MAIA files.
            Your health record PDFs in the local folder will not be deleted.
          </p>
          <p class="q-mt-md">
            This cannot be undone. Click GET STARTED to create a new account.
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

    <!-- Connect local MAIA folder dialog (shown after passkey sign-in without folder) -->
    <q-dialog v-model="showConnectFolderDialog">
      <q-card style="min-width: 420px; max-width: 560px">
        <q-card-section>
          <div class="text-h6">Connect Your MAIA Folder</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            You signed in with a passkey. To keep your local backup updated,
            connect the MAIA folder on this computer.
          </p>
          <p class="text-caption text-grey-7 q-mt-sm">
            Without a connected folder, changes made during this session
            will only be saved in the cloud. Your local backup will not be updated.
          </p>
        </q-card-section>
        <q-card-actions align="right" class="q-gutter-sm">
          <q-btn
            flat
            label="Skip for now"
            color="grey-8"
            @click="showConnectFolderDialog = false"
          />
          <q-btn
            unelevated
            label="Connect folder"
            color="primary"
            @click="handleConnectFolderFromDialog"
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
      :kb-name="restoreWizardKbName"
      :test-mode="testModeActive"
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
          <div class="text-h6">Delete Cloud Account</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>
            This frees up cloud resources for <strong>{{ user?.userId }}</strong>
            (agent, knowledge base, files). Deep links and passkey access will not work until you restore.
          </p>
          <p class="q-mt-sm">
            Your local folder and user data are kept so you can restore the account later.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="CANCEL"
            color="primary"
            v-close-popup
          />
          <q-btn
            label="DELETE"
            color="negative"
            :loading="destroyLoading"
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
import AdminUsers from './components/AdminUsers.vue';
import { useQuasar } from 'quasar';
import { saveUserSnapshot, getUserSnapshot, clearUserSnapshot } from './utils/localDb';
import {
  writeStateFile, clearDirectoryHandle, scanWeblocOwner,
  getActiveUserId, setActiveUserId, discoverUsers,
  readStateFileByUserId,
  type MaiaState, type DiscoveredUser
} from './utils/localFolder';
import packageJson from '../package.json';

const appVersion = packageJson.version;

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
const chatInterfaceRef = ref<InstanceType<typeof ChatInterface> | null>(null);
const isDeepLinkUser = ref(false);
const deepLinkInfo = ref<DeepLinkInfo | null>(null);
const deepLinkShareId = ref<string | null>(null);
const showDeepLinkAccess = ref(false);
const deepLinkLoading = ref(false);
const deepLinkError = ref('');
const showAdminPage = ref(false);
const welcomeIntro = ref<string>('');
const tempStartLoading = ref(false);
const tempStartError = ref('');
const showTempSignOutDialog = ref(false);
const showDestroyDialog = ref(false);
const destroyLoading = ref(false);
const passkeyPrefillUserId = ref<string | null>(null);
const passkeyPrefillAction = ref<'signin' | 'register' | null>(null);
/** When set, we showed PasskeyAuth for a returning passkey user (from Get Started + local snapshot). */
const welcomeBackPasskeyUserId = ref<string | null>(null);
const showPasskeyDialog = ref(false);
const showDormantDialog = ref(false);
const dormantDeepLinkCount = ref(0);
const dormantLoading = ref(false);
const signOutSnapshot = ref<SignOutSnapshot | null>(null);
const restoredChatState = ref<any | null>(null);
const rehydrationFiles = ref<any[]>([]);
const rehydrationActive = ref(false);
const suppressWizard = ref(false);
const showCloudHealthDialog = ref(false);
const cloudHealthDetails = ref<any>(null);
const cloudHealthLoading = ref(false);
/** [Phase 7] Restore Wizard state */
const showRestoreWizard = ref(false);
const restoreWizardLocalState = ref<MaiaState | null>(null);
const restoreWizardKbName = ref<string | null>(null);
const showDestroyedRestoreDialog = ref(false);
const destroyedUserId = ref<string | null>(null);
const showDevicePrivacyDialog = ref(false);
const showGetStartedChoiceDialog = ref(false);
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
const showConnectFolderDialog = ref(false);
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

/** Discovered users whose cloud status is 'restore' (account needs restoring). */
const restorableUsers = computed(() =>
  discoveredUsers.value.filter(du => welcomeUserCloudStatus.value[du.userId] === 'restore')
);

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

/** Per-user cloud status for Welcome page cards: 'loading' | 'ready' | 'restore' */
const welcomeUserCloudStatus = ref<Record<string, 'loading' | 'ready' | 'restore'>>({});

/** Check cloud status for all discovered users (called from loadWelcomeStatus). */
const checkAllUserCloudStatus = async () => {
  const users = discoveredUsers.value;
  if (users.length === 0) return;
  // Set all to loading initially
  const statusMap: Record<string, 'loading' | 'ready' | 'restore'> = {};
  for (const u of users) statusMap[u.userId] = 'loading';
  welcomeUserCloudStatus.value = { ...statusMap };
  // Check each user in parallel
  await Promise.all(users.map(async (u) => {
    try {
      const resp = await fetch(`/api/agent-exists?userId=${encodeURIComponent(u.userId)}`);
      if (resp.ok) {
        const data = await resp.json();
        // wizardComplete is derived from data presence on the server
        // (has agent + KB + endpoint + patientSummary + currentMedications)
        statusMap[u.userId] = data.wizardComplete ? 'ready' : 'restore';
      } else {
        statusMap[u.userId] = 'restore';
      }
    } catch {
      statusMap[u.userId] = 'restore';
    }
    welcomeUserCloudStatus.value = { ...statusMap };
  }));
};

/** Handle RESTORE on a discovered user card — uses /api/account/recreate to preserve original userId */
const handleUserCardRestore = async (du: DiscoveredUser) => {
  selectedWelcomeUserId.value = du.userId;
  setActiveUserId(du.userId);
  welcomeLocalUserId.value = du.userId;
  tempStartLoading.value = true;
  tempStartError.value = '';
  // Clear stale wizard flags from previous session to prevent My Lists auto-reload loop
  // and stale agent timer from persisting across restore attempts
  try {
    sessionStorage.removeItem('autoProcessInitialFile');
    sessionStorage.removeItem('wizardMyListsAuto');
    sessionStorage.removeItem(`wizard_agent_setup_started_${du.userId}`);
  } catch { /* ignore */ }
  try {
    // Step 1: Read local state FIRST — must happen while we're still in the user
    // gesture context (clicking RESTORE). Chrome's File System Access API only
    // allows requestPermission() during a user gesture, and awaiting a network
    // fetch exhausts that gesture window.
    let localState: MaiaState | null = null;
    if (localFolderHandle.value) {
      const { readStateFile } = await import('./utils/localFolder');
      localState = await readStateFile(localFolderHandle.value);
    }
    if (!localState && du.userId) {
      try {
        // requestWrite: true — we're inside the user gesture (RESTORE click)
        const result = await readStateFileByUserId(du.userId, { requestWrite: true });
        if (result) {
          localState = result.state;
          localFolderHandle.value = result.handle;
        } else {
        }
      } catch (e) {
      }
    }
    // If still no state, try prompting the user to pick their folder
    if (!localState && !localFolderHandle.value) {
      try {
        const { pickLocalFolder, readStateFile: readState } = await import('./utils/localFolder');
        const picked = await pickLocalFolder(du.userId);
        if (picked) {
          localFolderHandle.value = picked.handle;
          localFolderName.value = picked.folderName;
          localState = await readState(picked.handle);
        }
      } catch (e) {
      }
    }

    // Validate folder ownership via .webloc matches the userId being restored
    if (localState && localFolderHandle.value) {
      try {
        const weblocOwner = await scanWeblocOwner(localFolderHandle.value);
        if (weblocOwner && weblocOwner.userId && weblocOwner.userId !== du.userId) {
          console.warn(`[RESTORE] Folder owner mismatch: folder=${weblocOwner.userId} restore=${du.userId}`);
          if ($q && typeof $q.notify === 'function') {
            $q.notify({
              type: 'warning',
              message: `This folder belongs to ${weblocOwner.displayName || weblocOwner.userId}, not ${du.userId}. Cannot restore from a mismatched folder.`,
              timeout: 7000
            });
          }
          localState = null;
        }
      } catch { /* .webloc unreadable — proceed with caution */ }
    }

    if (!localState) {
      const snapshot = await getUserSnapshot(du.userId);
      if (snapshot) {
        localState = {
          version: 1,
          userId: du.userId,
          displayName: du.displayName,
          updatedAt: snapshot.updatedAt || new Date().toISOString(),
          files: Array.isArray(snapshot.fileStatusSummary) ? snapshot.fileStatusSummary.map((f: any) => ({
            fileName: f.fileName, bucketKey: f.bucketKey, cloudStatus: f.chipStatus
          })) : undefined,
          currentMedications: snapshot.currentMedications || null,
          patientSummary: snapshot.patientSummary || null,
          savedChats: snapshot.savedChats || undefined,
          currentChat: snapshot.currentChat || undefined
        };
      } else {
      }
    }

    // Bail out early if there's nothing to restore
    if (!localState) {
      console.warn(`[RESTORE] No local state found — cannot proceed with restore`);
      if ($q && typeof $q.notify === 'function') {
        $q.notify({ type: 'warning', message: 'No local backup found. Please use GET STARTED to set up your account.', timeout: 5000 });
      }
      tempStartLoading.value = false;
      return;
    }

    // Step 2: Recreate the user doc (now we know we have local state to restore)
    const recreateResp = await fetch('/api/account/recreate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: du.userId, displayName: du.displayName })
    });
    const recreateData = await recreateResp.json();
    if (!recreateResp.ok || !recreateData.authenticated) {
      throw new Error(recreateData.error || 'Failed to recreate account');
    }
    suppressWizard.value = true; // Prevent ChatInterface from polling agent-setup-status during restore
    restoreWizardKbName.value = recreateData.kbName || null;
    setAuthenticatedUser(recreateData.user, null);

    // Cloud health check
    try {
      const healthResp = await fetch(`/api/cloud-health?userId=${encodeURIComponent(du.userId)}`, { credentials: 'include' });
      if (healthResp.ok) {
        const health = await healthResp.json();
        cloudHealthDetails.value = health.details || null;
      }
    } catch {
      cloudHealthDetails.value = {
        database: { ok: true },
        agent: { ok: false, error: 'Not deployed' },
        knowledgeBase: { ok: false, error: 'Not created' },
        spacesFiles: { ok: false, error: 'No files' }
      };
    }

    // Launch RestoreWizard (localState is guaranteed non-null at this point)
    restoreWizardLocalState.value = localState;
    showRestoreWizard.value = true;
  } catch (error) {
    tempStartError.value = error instanceof Error ? error.message : 'Restore failed';
  } finally {
    tempStartLoading.value = false;
  }
};

/** [AUTH] New client = no local backup and no temp cookie. */
const isNewClient = computed(() => !welcomeLocalUserId.value && !welcomeStatus.value.tempCookieUserId);

/** [MULTI-USER] Users discovered from IndexedDB folder handles + .webloc scan. */
const discoveredUsers = ref<DiscoveredUser[]>([]);
/** [MULTI-USER] Currently selected userId in the Welcome page selector. */
const selectedWelcomeUserId = ref<string | null>(null);

/** Refresh discoveredUsers from IndexedDB + .webloc scan. */
const refreshDiscoveredUsers = async () => {
  discoveredUsers.value = await discoverUsers();
  // Auto-select: active user, or first discovered user
  if (!selectedWelcomeUserId.value || !discoveredUsers.value.some(u => u.userId === selectedWelcomeUserId.value)) {
    selectedWelcomeUserId.value = getActiveUserId() || discoveredUsers.value[0]?.userId || null;
  }
};

/** When user switches in the multi-user toggle, reload welcome status for that user. */
/** Add family member: go through new-account flow */
const addingFamilyMember = ref(false);
const handleAddFamilyMember = () => {
  // Clear any existing user context so startTemporarySession creates a new account
  addingFamilyMember.value = true;
  welcomeLocalUserId.value = null;
  selectedWelcomeUserId.value = null;
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
  await refreshDiscoveredUsers();
  // Check cloud status for all discovered users (parallel, non-blocking)
  void checkAllUserCloudStatus();
  // Use selected user from multi-user selector, fall back to active user
  welcomeLocalUserId.value = selectedWelcomeUserId.value || getActiveUserId();
  welcomeLocalSnapshot.value = null;
  welcomeLocalHasPasskey.value = null;
  welcomeAgentExists.value = null;
  welcomeCloudFileCount.value = null;
  welcomeSavedFileCount.value = null;
  welcomeKbExists.value = null;
  welcomeAgentLinkedToKb.value = null;
  welcomeWizardComplete.value = null;
  const localId = welcomeLocalUserId.value;
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
      // Try active folder handle first, then try reconnecting stored handle (queryPermission only, no gesture)
      let folderHandle = localFolderHandle.value;
      if (!folderHandle && localId) {
        try {
          const result = await readStateFileByUserId(localId);
          if (result) {
            folderHandle = result.handle;
            // Also populate localFolderHandle so subsequent operations can use it
            localFolderHandle.value = result.handle;
          }
        } catch {
          // Not available without gesture, will fall back to IndexedDB
        }
      }
      if (folderHandle) {
        try {
          const { readStateFile } = await import('./utils/localFolder');
          const folderState = await readStateFile(folderHandle);
          if (folderState) {
            foundLocalState = true;
            localFileCount = Array.isArray(folderState.files) ? folderState.files.length : 0;
            localIndexedCount = Array.isArray(folderState.files) ? folderState.files.filter(f => f.cloudStatus === 'indexed').length : 0;
            localMedsVerified = !!(folderState.currentMedications != null && String(folderState.currentMedications).trim() !== '');
            localSummaryVerified = !!(folderState.patientSummary != null && String(folderState.patientSummary).trim() !== '');
            localWizardComplete = localMedsVerified && localSummaryVerified;
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
      }
      // If folder/IndexedDB reads failed, check if a stored folder handle exists
      // (doesn't need permission) — the user can re-grant via RESTORE click
      if (!foundLocalState && localId) {
        try {
          const { hasStoredHandle } = await import('./utils/localFolder');
          if (await hasStoredHandle(localId)) {
            foundLocalState = true;
          }
        } catch { /* ignore */ }
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

  // Track active user (skip deep-link users)
  if (!normalizedUser.isDeepLink) {
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
      // Save local snapshot before deleting cloud resources
      await saveLocalSnapshot(null);
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
      // Save local snapshot before destroying cloud resources
      await saveLocalSnapshot(null);
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
    // Prompt to connect a local folder if one isn't already connected
    // Check if this user has a stored folder handle in IndexedDB
    if (!localFolderHandle.value && typeof window !== 'undefined') {
      try {
        const result = await readStateFileByUserId(userData.userId);
        if (result) {
          localFolderHandle.value = result.handle;
          localFolderName.value = result.handle.name;
          passkeyWithoutFolder.value = false;
        } else {
          showConnectFolderDialog.value = true;
        }
      } catch {
        showConnectFolderDialog.value = true;
      }
    }
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
    const [filesResponse, chatsResponse, statusResponse, summaryResponse, instrResponse, listsResponse] = await Promise.all([
      fetch(`/api/user-files?userId=${uid}`, { credentials: 'include' }),
      fetch(`/api/user-chats?userId=${uid}`, { credentials: 'include' }),
      fetch(`/api/user-status?userId=${uid}`, { credentials: 'include' }),
      fetch(`/api/patient-summary?userId=${uid}`, { credentials: 'include' }),
      fetch(`/api/agent-instructions?userId=${uid}`, { credentials: 'include' }).catch(() => null),
      fetch('/api/files/lists/markdown', { credentials: 'include' }).catch(() => null)
    ]);

    const files = filesResponse.ok ? await filesResponse.json() : null;
    const savedChats = chatsResponse.ok ? await chatsResponse.json() : null;
    const status = statusResponse.ok ? await statusResponse.json() : null;
    const summary = summaryResponse.ok ? await summaryResponse.json() : null;
    const instrData = instrResponse && instrResponse.ok ? await instrResponse.json() : null;
    const listsData = listsResponse && listsResponse.ok ? await listsResponse.json() : null;
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
        // Read existing local state so we don't overwrite good data with empty cloud responses
        let existingState: MaiaState | null = null;
        try {
          const { readStateFile } = await import('./utils/localFolder');
          existingState = await readStateFile(localFolderHandle.value);
        } catch { /* first time, no existing state */ }
        const state: MaiaState = {
          version: 2,
          userId: user.value.userId,
          displayName: user.value.displayName,
          updatedAt: now,
          exportedAt: now,
          files: filesList.length > 0 ? filesList.map((f: any) => {
            const bk = f.bucketKey || '';
            const kbPrefix = kbName ? `${user.value?.userId}/${kbName}/` : null;
            const inKB = kbPrefix ? bk.startsWith(kbPrefix) : false;
            let cs: 'indexed' | 'pending' | 'not_in_kb' | 'uploaded' = 'not_in_kb';
            if (inKB && indexedSet.has(bk)) cs = 'indexed';
            else if (inKB) cs = 'pending';
            return { fileName: f.fileName, size: f.fileSize, cloudStatus: cs, bucketKey: bk };
          }) : existingState?.files || [],
          currentMedications: (status?.currentMedications && status.currentMedications.trim()) ? status.currentMedications : (existingState?.currentMedications || null),
          patientSummary: (summary?.summary && summary.summary.trim()) ? summary.summary : (existingState?.patientSummary || null),
          savedChats: (savedChats?.chats?.length || savedChats?.length) ? savedChats : (existingState?.savedChats || undefined),
          currentChat: snapshot?.currentChat || existingState?.currentChat || undefined,
          agentInstructions: (instrData?.instructions && instrData.instructions.trim()) ? instrData.instructions : (existingState?.agentInstructions || null),
          listsMarkdown: (listsData?.hasMarkdown && listsData?.markdown) ? listsData.markdown : (existingState?.listsMarkdown || null),
          kbStats: indexedCount > 0
            ? { fileCount: indexedCount, tokenCount: files?.tokenCount || 0 }
            : existingState?.kbStats || { fileCount: 0, tokenCount: 0 },
          // Derive wizard completion from data presence: has meds + summary + files = complete
          wizardComplete: !!(
            ((status?.currentMedications && status.currentMedications.trim()) || existingState?.currentMedications) &&
            ((summary?.summary && summary.summary.trim()) || existingState?.patientSummary)
          ),
          // Preserve provisioningLog from existing state (managed by ChatInterface.saveStateToLocalFolder)
          provisioningLog: existingState?.provisioningLog || undefined,
        };
        await writeStateFile(localFolderHandle.value, state);

        // Extract patient name for webloc shortcut
        let extractedPatientName: string | null = null;
        try {
          const folderUtils = await import('./utils/localFolder');
          extractedPatientName = typeof folderUtils.extractPatientName === 'function'
            ? folderUtils.extractPatientName(state.patientSummary)
            : null;
        } catch { /* extraction not critical */ }

        // Always update webloc shortcut at sign-out (this is the ownership marker)
        if (user.value?.userId) {
          try {
            const folderUtils = await import('./utils/localFolder');
            await folderUtils.writeWeblocFile(localFolderHandle.value, window.location.origin, {
              patientName: extractedPatientName || undefined,
              userId: user.value.userId
            });
          } catch (e: any) {
          }
        }
      } catch (e: any) {
      }
    } else {
    }
  } catch (error) {
    console.warn('Failed to save local snapshot:', error);
  }
};

/** Handle "Connect folder" button from the passkey-without-folder dialog. */
const handleConnectFolderFromDialog = async () => {
  showConnectFolderDialog.value = false;
  if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      const folderName = handle.name;
      localFolderHandle.value = handle;
      localFolderName.value = folderName;
      passkeyWithoutFolder.value = false;
      // Store the handle for future reconnection
      const { storeDirectoryHandle } = await import('./utils/localFolder');
      if (user.value?.userId) {
        await storeDirectoryHandle(user.value.userId, handle);
      }
      // Safety check: reject if folder .webloc belongs to a different user
      const weblocOwner = await scanWeblocOwner(handle);
      if (weblocOwner && weblocOwner.userId && user.value?.userId && weblocOwner.userId !== user.value.userId) {
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'warning',
            message: `This folder belongs to ${weblocOwner.displayName || weblocOwner.userId}. Please choose a different folder.`,
            timeout: 7000
          });
        }
        localFolderHandle.value = null;
        localFolderName.value = '';
        return;
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.warn('[AUTH] Folder picker failed:', e);
      }
    }
  }
};

/** Handle local-folder-connected event from ChatInterface. */
const handleLocalFolderConnected = async (payload: { handle: FileSystemDirectoryHandle; folderName: string }) => {
  localFolderHandle.value = payload.handle;
  localFolderName.value = payload.folderName;

  // Safety check: reject if folder .webloc belongs to a different user
  try {
    const weblocOwner = await scanWeblocOwner(payload.handle);
    if (weblocOwner && weblocOwner.userId && user.value?.userId && weblocOwner.userId !== user.value.userId) {
      console.warn(`[FOLDER] Folder "${payload.folderName}" belongs to ${weblocOwner.userId}, rejecting for ${user.value.userId}`);
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'warning',
          message: `This folder belongs to ${weblocOwner.displayName || weblocOwner.userId}. Please choose a different folder.`,
          timeout: 7000
        });
      }
      localFolderHandle.value = null;
      localFolderName.value = '';
      return;
    }
  } catch (e) {
    console.warn('[localFolder] Folder ownership check failed:', e);
  }

  // Track active user
  if (user.value?.userId) {
    setActiveUserId(user.value.userId);
  }
};

/** [WIZARD] Save state to local folder when wizard completes (so maia-state.json is current). */
const handleWizardComplete = async () => {
  try {
    await saveLocalSnapshot(null);
    // Also update the webloc NOW (don't wait for sign-out) since the patient summary is fresh
    if (localFolderHandle.value && user.value?.userId) {
      try {
        const { readStateFile, writeWeblocFile } = await import('./utils/localFolder');
        const currentState = await readStateFile(localFolderHandle.value);
        const { extractPatientName } = await import('./utils/localFolder');
        const patientName = extractPatientName(currentState?.patientSummary);
        await writeWeblocFile(localFolderHandle.value, window.location.origin, {
          patientName: patientName || undefined,
          userId: user.value.userId
        });
      } catch (e) {
        console.warn('[WIZARD-COMPLETE] Webloc update failed:', e);
      }
    }
  } catch (e) {
    console.warn('[WIZARD-COMPLETE] Failed to save local state:', e);
  }
};

/** Handle TEST mode: setup is complete — orchestrate Delete → Restore → Verify cycle. */
const testModeActive = ref(false);
const testSetupVerification = ref<any>(null);

const handleTestSetupComplete = async (payload: { verification: any; folderHandle: FileSystemDirectoryHandle }) => {
  const ci = chatInterfaceRef.value as any;
  if (!ci) return;
  const log = (text: string, ok = true) => ci.addTestLog(text, ok);

  testModeActive.value = true;
  testSetupVerification.value = payload.verification;

  try {
    // Step 1: Validate maia-state.json from local folder
    log('Reading maia-state.json from local folder...');
    let localState: MaiaState | null = null;
    try {
      const { readStateFile } = await import('./utils/localFolder');
      localState = await readStateFile(payload.folderHandle);
    } catch (e: any) {
      log(`Failed to read maia-state.json: ${e.message}`, false);
      testModeActive.value = false;
      return;
    }

    if (localState) {
      const { validateBackupState } = await import('./utils/setupRestoreTest');
      const validation = validateBackupState(localState);
      if (validation.valid) {
        log('maia-state.json validated ✓');
      } else {
        for (const err of validation.errors) {
          log(`Backup: ${err}`, false);
        }
        log('maia-state.json has issues — continuing anyway');
      }
    } else {
      log('maia-state.json not found or empty', false);
      testModeActive.value = false;
      return;
    }

    // Step 2: Delete cloud account
    log('Deleting cloud account...');
    const userId = user.value?.userId;
    if (!userId) {
      log('No userId — cannot delete', false);
      testModeActive.value = false;
      return;
    }

    // Log to provisioning log before delete
    try {
      await fetch('/api/provisioning-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId, event: 'account-deleted' })
      });
    } catch { /* non-fatal */ }

    const deleteResp = await fetch('/api/self/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId })
    });
    if (!deleteResp.ok) {
      const errData = await deleteResp.json().catch(() => ({}));
      log(`Delete failed: ${errData.error || deleteResp.status}`, false);
      testModeActive.value = false;
      return;
    }
    log('Cloud account deleted');

    // Step 3: Recreate account
    log('Recreating account...');
    const recreateResp = await fetch('/api/account/recreate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId })
    });
    const recreateData = await recreateResp.json();
    if (!recreateResp.ok || !recreateData.authenticated) {
      log(`Recreate failed: ${recreateData.error || 'unknown'}`, false);
      testModeActive.value = false;
      return;
    }
    restoreWizardKbName.value = recreateData.kbName || null;
    setAuthenticatedUser(recreateData.user, null);
    log('Account recreated');

    // Step 4: Check cloud health
    const healthResp = await fetch(
      `/api/cloud-health?userId=${encodeURIComponent(userId)}`,
      { credentials: 'include' }
    );
    if (healthResp.ok) {
      cloudHealthDetails.value = (await healthResp.json()).details || null;
    }

    // Step 5: Launch RestoreWizard — it will call handleRestoreWizardComplete when done
    log('Launching Restore Wizard...');
    restoreWizardLocalState.value = localState;
    showRestoreWizard.value = true;

    // The rest happens in handleRestoreWizardComplete which checks testModeActive

  } catch (err: any) {
    log(`Test error: ${err.message}`, false);
    testModeActive.value = false;
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
  // Cloud user (has passkey) → challenge passkey directly
  if (welcomeUserType.value === 'cloud') {
    const userId = welcomeDisplayUserId.value;
    passkeyPrefillUserId.value = userId || null;
    passkeyPrefillAction.value = 'signin';
    showAuth.value = true;
    return;
  }
  // If there are known users needing restore, ask the user what they want to do
  // instead of silently creating a new account
  if (restorableUsers.value.length > 0) {
    showGetStartedChoiceDialog.value = true;
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

/** GET STARTED on a specific discovered-user card (green badge) — set context and delegate to main handler */
const handleGetStartedForUser = (du: DiscoveredUser) => {
  selectedWelcomeUserId.value = du.userId;
  setActiveUserId(du.userId);
  welcomeLocalUserId.value = du.userId;
  handleGetStartedNoPassword();
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

  // Try to reconnect the local folder handle if missing.
  // Pass requestWrite:true — the Sign Out button click is a user gesture,
  // so Chrome will show its "allow access" prompt if permission expired.
  if (!localFolderHandle.value && user.value.userId) {
    try {
      const result = await readStateFileByUserId(user.value.userId, { requestWrite: true });
      if (result) {
        localFolderHandle.value = result.handle;
      }
    } catch { /* not available */ }
  }

  // No folder handle? Proceed silently. saveLocalSnapshot still writes to
  // IndexedDB, and discoverUsers() surfaces the user as a Welcome card on
  // return. The legacy "Save Updated Files" modal (with its Chrome-specific
  // DOWNLOAD BACKUP wording) was removed.
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

/** [AUTH] Open delete confirmation dialog for a user from welcome page badge X. */
const handleDeleteUser = (userIdOrEvent?: string | Event) => {
  if (typeof userIdOrEvent === 'string') {
    welcomeLocalUserId.value = userIdOrEvent;
    selectedWelcomeUserId.value = userIdOrEvent;
  }
  showDeleteLocalUserDialog.value = true;
};

/** [AUTH] Confirmed full delete: cloud account + local MAIA files + IndexedDB handle. Nothing to restore. */
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
    await clearUserSnapshot(localId);
    clearWizardPendingKey(localId);
    if (getActiveUserId() === localId) {
      setActiveUserId(null);
    }
    // Remove MAIA files from local folder (keep health record PDFs)
    const handleToClean = localFolderHandle.value;
    if (handleToClean) {
      try {
        await handleToClean.removeEntry('maia-state.json').catch(() => {});
        await handleToClean.removeEntry('maia-log.pdf').catch(() => {});
        await handleToClean.removeEntry('maia-setup-log.pdf').catch(() => {}); // legacy name
        for await (const [name] of (handleToClean as any).entries()) {
          if (name.endsWith('.webloc') && name.startsWith('maia')) {
            await handleToClean.removeEntry(name).catch(() => {});
          }
        }
      } catch (cleanErr) {
        console.warn(`[WELCOME] Could not clean local folder files:`, cleanErr);
      }
      localFolderHandle.value = null;
      localFolderName.value = '';
    }
    try {
      await clearDirectoryHandle(localId);
    } catch { /* non-fatal */ }
    // Clear the httpOnly temp-user cookie so /api/welcome-status doesn't re-surface this user
    await fetch('/api/auth/clear-temp-cookie', { method: 'POST', credentials: 'include' }).catch(() => {});
    await refreshDiscoveredUsers();
    selectedWelcomeUserId.value = discoveredUsers.value[0]?.userId || null;
    // Reset welcome state so GET STARTED creates a new userId
    welcomeLocalUserId.value = null;
    welcomeLocalSnapshot.value = null;
    welcomeLocalHasPasskey.value = null;
    welcomeAgentExists.value = null;
    welcomeCloudFileCount.value = null;
    welcomeKbExists.value = null;
    welcomeAgentLinkedToKb.value = null;
    welcomeWizardComplete.value = null;
    welcomeSavedFileCount.value = null;
    welcomeStatus.value = {};
    showDeleteLocalUserDialog.value = false;
    // Reload welcome status to reflect the deletion
    void loadWelcomeStatus();
    if ($q && typeof $q.notify === 'function') {
      $q.notify({ type: 'positive', message: `${localId} deleted. Click GET STARTED to create a new account.`, timeout: 5000 });
    }
  } catch (error) {
    console.error('[AUTH] Local user delete failed:', error);
  } finally {
    deleteLocalUserLoading.value = false;
  }
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
    if (getActiveUserId() === uid) setActiveUserId(null);
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

/** Phase 7: Handle log events from RestoreWizard (no-op, provisioning log handles this now). */
/** Phase 7: Restore Wizard completed — close dialog, clear health state, notify user. */
const handleRestoreWizardComplete = async () => {
  showRestoreWizard.value = false;
  restoreWizardLocalState.value = null;
  cloudHealthDetails.value = null;
  suppressWizard.value = true; // Don't re-enter the wizard flow
  // Mark wizard as complete on the server so it doesn't re-trigger
  if (user.value?.userId) {
    try {
      await fetch('/api/user-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: user.value.userId, workflowStage: 'patient_summary' })
      });
    } catch { /* non-critical */ }
  }
  // Store handle and update webloc ownership for the restored user
  if (localFolderHandle.value && user.value?.userId) {
    try {
      const { storeDirectoryHandle } = await import('./utils/localFolder');
      await storeDirectoryHandle(user.value.userId, localFolderHandle.value);
    } catch (e) {
      console.warn('[RESTORE] Failed to store handle:', e);
    }
    // Write personalized webloc (same as handleWizardComplete)
    try {
      const { readStateFile, writeWeblocFile, extractPatientName } = await import('./utils/localFolder');
      const currentState = await readStateFile(localFolderHandle.value);
      const patientName = extractPatientName(currentState?.patientSummary);
      await writeWeblocFile(localFolderHandle.value, window.location.origin, {
        patientName: patientName || undefined,
        userId: user.value.userId
      });
    } catch (e) {
      console.warn('[RESTORE] Webloc update failed:', e);
    }
    // Save local state snapshot so maia-state.json reflects restored data
    try {
      await saveLocalSnapshot(null);
    } catch (e) {
      console.warn('[RESTORE] Local state snapshot failed:', e);
    }
  }
  // Re-sync agent status so the app recognizes the deployed agent
  if (user.value?.userId) {
    try {
      await fetch('/api/agent-setup-status', { credentials: 'include' });
    } catch { /* non-critical */ }
  }
  // Mark indexing as already completed so refreshWizardState doesn't
  // re-create indexingStatus and log a duplicate "Indexing Complete" entry
  if (chatInterfaceRef.value) {
    chatInterfaceRef.value.markIndexingAlreadyCompleted();
  }
  suppressWizard.value = false; // Allow normal ChatInterface operation now
  // Regenerate maia-log.pdf with all restore entries
  try {
    if (chatInterfaceRef.value) {
      await chatInterfaceRef.value.generateSetupLogPdf();
    }
  } catch (e) {
    console.warn('[RESTORE] Log PDF generation failed:', e);
  }
  if ($q && typeof $q.notify === 'function') {
    $q.notify({ type: 'positive', message: 'Account restored successfully!', timeout: 3000 });
  }

  // If TEST mode is active, run post-restore verification and comparison
  if (testModeActive.value && chatInterfaceRef.value) {
    const ci = chatInterfaceRef.value as any;
    const log = (text: string, ok = true) => ci.addTestLog(text, ok);
    try {
      log('Restore complete — verifying all tabs...');
      // Small delay to let server settle
      await new Promise(r => setTimeout(r, 2000));

      const { verifyAllTabs, compareResults, formatVerification, formatComparison } =
        await import('./utils/setupRestoreTest');

      const restoreVerification = await verifyAllTabs(user.value!.userId);
      log(`Files: ${restoreVerification.files.count}`, restoreVerification.files.count > 0);
      log(`Agent: ${restoreVerification.agentReady ? 'ready' : 'not ready'}`, restoreVerification.agentReady);
      log(`KB: ${restoreVerification.kbIndexed ? `indexed (${restoreVerification.kbTokens} tokens)` : 'not indexed'}`, restoreVerification.kbIndexed);
      log(`Medications: ${restoreVerification.medications.lines} lines`, restoreVerification.medications.lines > 0);
      log(`Summary: ${restoreVerification.summary.lines} lines, ${restoreVerification.summary.chars} chars`, restoreVerification.summary.lines > 0);
      log(`Chats: ${restoreVerification.chats.count}`, true);

      // Compare setup vs restore
      const comparison = compareResults(testSetupVerification.value, restoreVerification);
      log('');
      log(comparison.passed ? '=== ALL CHECKS PASSED ===' : '=== SOME CHECKS FAILED ===', comparison.passed);
      for (const check of comparison.checks) {
        if (check.passed) {
          log(`  ${check.name}: match`);
        } else {
          const exp = check.expected.length > 50 ? check.expected.slice(0, 50) + '...' : check.expected;
          const act = check.actual.length > 50 ? check.actual.slice(0, 50) + '...' : check.actual;
          log(`  ${check.name}: "${exp}" != "${act}"`, false);
        }
      }

      // Collect warnings/errors that fired during this TEST run from the provisioning log
      const warningLines: string[] = [];
      try {
        const logRes = await fetch(`/api/provisioning-log?userId=${encodeURIComponent(user.value!.userId)}`, { credentials: 'include' });
        if (logRes.ok) {
          const logJson = await logRes.json();
          const events: any[] = Array.isArray(logJson?.log) ? logJson.log : (Array.isArray(logJson?.events) ? logJson.events : []);
          // Find the most recent test-started; collect events after it
          let startIdx = -1;
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i]?.event === 'test-started') { startIdx = i; break; }
          }
          const scope = startIdx >= 0 ? events.slice(startIdx) : events;
          const warnEvents = new Set([
            'current-medications-recovery-failed',
            'medications-dismissed',
            'agent-deploy-failed',
            'kb-index-failed',
            'summary-generation-failed',
            'restore-error',
            'setup-error'
          ]);
          for (const ev of scope) {
            const name = ev?.event;
            if (warnEvents.has(name)) {
              if (name === 'current-medications-recovery-failed') {
                const tried = Array.isArray(ev.pathsTried) ? ev.pathsTried.join(' -> ') : '';
                warningLines.push(`  \u26A0 Current Medications recovery failed${tried ? ` (tried: ${tried})` : ''}${ev.reason ? ` — ${ev.reason}` : ''}`);
              } else if (name === 'medications-dismissed') {
                warningLines.push(`  \u26A0 Medications dismissed without verification${ev.reason ? ` — ${ev.reason}` : ''}`);
              } else {
                warningLines.push(`  \u26A0 ${name}${ev.error ? `: ${ev.error}` : ''}`);
              }
            } else if (name === 'medications-offered' && ev.outcome && ev.outcome !== 'verified' && ev.outcome !== 'shown') {
              warningLines.push(`  \u26A0 Medications offered: ${ev.outcome}${ev.detail ? ` (${ev.detail})` : ''}`);
            }
          }
        }
      } catch { /* non-fatal */ }

      // Set the full output for the pre block
      const sections = [
        formatVerification('SETUP', testSetupVerification.value),
        '',
        formatVerification('RESTORE', restoreVerification),
        '',
        formatComparison(comparison)
      ];
      if (warningLines.length > 0) {
        sections.push('');
        sections.push(`Warnings during TEST (${warningLines.length}):`);
        sections.push(...warningLines);
      }
      ci.setTestFinalOutput(sections.join('\n'));

      // Close MyStuff dialog so the test results panel in ChatInterface is visible
      try { ci.closeMyStuff(); } catch { /* non-fatal */ }

      // Save updated local snapshot so the account shows as healthy (no orange badge)
      try {
        await saveLocalSnapshot(null);
      } catch { /* non-fatal */ }

      // Emit test-completed BEFORE regenerating the PDF so it shows in the log
      try {
        await fetch('/api/provisioning-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: user.value!.userId,
            event: 'test-completed',
            passed: comparison.passed
          })
        });
      } catch { /* non-fatal */ }

      // Regenerate maia-log.pdf with all test entries
      try {
        await ci.generateSetupLogPdf();
      } catch { /* non-fatal */ }

    } catch (err: any) {
      log(`Post-restore verification failed: ${err.message}`, false);
      try {
        await fetch('/api/provisioning-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: user.value!.userId,
            event: 'test-completed',
            passed: false,
            error: err?.message
          })
        });
      } catch { /* non-fatal */ }
    } finally {
      testModeActive.value = false;
      testSetupVerification.value = null;
    }
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
    restoreWizardKbName.value = recreateData.kbName || null;
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

const createTemporarySession = async () => {
  // Clear stale wizard flags from any previous session (e.g. destroyed user)
  try {
    sessionStorage.removeItem('autoProcessInitialFile');
    sessionStorage.removeItem('wizardMyListsAuto');
  } catch { /* ignore */ }

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

const handleRehydrationComplete = (_payload: { hasInitialFile: boolean }) => {
  rehydrationActive.value = false;
  suppressWizard.value = false;
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

  await handleDormantSignOut();
};

const handleTemporarySignOut = async () => {
  showTempSignOutDialog.value = false;
  await handleDormantSignOut();
};

const startTemporarySession = async () => {
  tempStartLoading.value = true;
  tempStartError.value = '';
  try {
    // When adding a family member, skip restore and go straight to new account creation
    const activeUserId = addingFamilyMember.value ? null : (selectedWelcomeUserId.value || getActiveUserId());
    if (addingFamilyMember.value) {
      addingFamilyMember.value = false;
      const newUser = await createTemporarySession();
      if (!newUser) return;
    } else if (activeUserId) {
      // If the stored user has a passkey, guide them to sign in instead of restoring as temporary
      try {
        const checkResponse = await fetch(`/api/passkey/check-user?userId=${encodeURIComponent(activeUserId)}`, {
          credentials: 'include'
        });
        if (checkResponse.ok) {
          const checkData = await checkResponse.json();
          if (checkData.exists && checkData.hasPasskey) {
            passkeyPrefillUserId.value = activeUserId;
            passkeyPrefillAction.value = 'signin';
            welcomeBackPasskeyUserId.value = activeUserId;
            showAuth.value = true;
            return;
          }
        }
      } catch (_) {
        // If check fails, continue with restore flow
      }

      // Try to restore temporary session for the known userId.
      // If restore fails (404 = user destroyed), fall through to create a new account.
      const restoreResponse = await fetch('/api/temporary/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ userId: activeUserId })
      });
      if (restoreResponse.ok) {
        const restoreData = await restoreResponse.json();
        if (restoreData.authenticated && restoreData.user) {
          setAuthenticatedUser(restoreData.user, null);
        } else {
          throw new Error(restoreData.error || 'Unable to restore temporary account');
        }
      } else {
        // User was destroyed or doesn't exist in cloud — delegate to restore wizard
        // which can re-request folder permission (user gesture) and recover local data
        const du = discoveredUsers.value.find(u => u.userId === activeUserId);
        if (du) {
          tempStartLoading.value = false;
          await handleUserCardRestore(du);
          return;
        }
        // No known user entry — fall through to create new account
        const newUser = await createTemporarySession();
        if (!newUser) return;
      }
    } else {
      // Phase 4: If known users exist, confirm before creating a new account
      if (discoveredUsers.value.length > 0) {
        const names = discoveredUsers.value.map(u => u.displayName).join(', ');
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

    // Legacy "Restore Local Backup?" modal removed. Users with a local
    // snapshot but no folder handle now appear as Welcome-page cards
    // (discoverUsers() enumerates _pouch_maia-user-* IndexedDB databases),
    // so they can RESTORE via the standard card flow or X to delete —
    // instead of a confusing modal with SKIP/RESTORE and Chrome-specific wording.

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
  if (!user.value?.userId) {
    return;
  }
  destroyLoading.value = true;
  const userIdToDelete = user.value.userId;
  try {
    // Save local state snapshot BEFORE deleting cloud data (preserves chats, meds, summary)
    try {
      await saveLocalSnapshot(null);
    } catch (snapErr) {
      console.warn(`[DESTROY] Local state save failed (non-fatal):`, snapErr);
    }

    // Regenerate maia-log.pdf
    try {
      if (chatInterfaceRef.value) {
        await chatInterfaceRef.value.generateSetupLogPdf();
      }
    } catch (logErr) {
      console.warn(`[DESTROY] Setup log update failed (non-fatal):`, logErr);
    }

    // Log account-deleted to provisioning log BEFORE deleting the account
    try {
      await fetch('/api/provisioning-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: userIdToDelete, event: 'account-deleted' })
      });
    } catch (err) {
      console.warn('[DESTROY] Provisioning log account-deleted failed (non-fatal):', err);
    }

    const response = await fetch('/api/self/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({ userId: userIdToDelete })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[DESTROY] Server returned ${response.status}:`, data);
      throw new Error(data.error || 'Failed to delete temporary account');
    }
    // Keep the folder handle so the Welcome page can offer RESTORE from local data.
    // Only clear the PouchDB snapshot (cloud state is gone, but folder-based state remains).
    await clearUserSnapshot(userIdToDelete, { keepDirectoryHandle: true });
    await refreshDiscoveredUsers();
    resetAuthState();
    showDestroyDialog.value = false;
  } catch (error) {
    console.error('[DESTROY] Temporary account deletion error:', error);
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

const loadWelcomeIntro = async () => {
  try {
    const response = await fetch('/welcome.md', { cache: 'no-cache' });
    if (!response.ok) return;
    const text = await response.text();
    welcomeIntro.value = text.trim();
  } catch (error) {
    console.error('Error loading welcome intro:', error);
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
  // Discover users from IndexedDB folder handles + .webloc scan
  await refreshDiscoveredUsers();

  // Phase 6: Register beforeunload listener
  window.addEventListener('beforeunload', beforeUnloadHandler);

  // Load welcome introduction from welcome.md
  loadWelcomeIntro();
  
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
    // Welcome page always shows — user clicks CONTINUE/SIGN IN on their card
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

.welcome-intro {
  background-color: #f5f5f5;
  border-radius: 4px;
}

.welcome-footer-link {
  color: #1976d2;
  text-decoration: none;
  font-size: 0.9rem;
  cursor: pointer;
}

.welcome-footer-link:hover {
  text-decoration: underline;
}

.more-choices-card .more-choices-actions .q-btn {
  min-height: 44px;
}
</style>

