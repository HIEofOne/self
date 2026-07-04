<template>
  <div class="chat-interface">
    <q-card class="full-height">
      <q-card-section class="q-pa-none full-height flex column">
        <!-- Initial load: show only spinner until wizard/chat is ready (avoids "Private AI unavailable" before wizard) -->
        <div v-if="!initialLoadComplete" class="full-height flex flex-center column" style="min-height: 280px;">
          <q-spinner size="3em" color="primary" />
          <div class="text-body2 text-grey-7 q-mt-md">Setting up...</div>
        </div>
        <template v-else>
        <!-- Phase 5: Passkey-only session warning banner -->
        <q-banner v-if="props.passkeyWithoutFolder" dense class="bg-amber-1 text-caption q-mb-none" style="flex-shrink: 0;">
          <template v-slot:avatar>
            <q-icon name="info" color="amber-8" size="sm" />
          </template>
          Your local backup will not be updated in this session. Access MAIA from your original device to keep your local folder current.
        </q-banner>
        <!-- File Info Bar -->
        <div v-if="uploadedFiles.length > 0" class="q-px-md q-pt-md q-pb-sm" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
          <div class="row items-center q-gutter-xs">
            <q-chip
              v-for="file in uploadedFiles"
              :key="file.id"
              icon="description"
              color="primary"
              text-color="white"
              size="sm"
            >
              {{ file.name }}
              <q-btn 
                flat dense round size="xs" 
                icon="visibility" 
                color="white"
                @click="viewFile(file)"
              />
              <q-btn 
                flat dense round size="xs" 
                icon="close" 
                color="white"
                @click="removeFile(file)"
              />
            </q-chip>
          </div>
        </div>
        
        <div v-if="isUploadingFile" class="q-px-md q-pt-sm q-pb-sm" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
          <div class="text-xs text-grey-6">Uploading...</div>
        </div>

        <!-- Chat Area -->
        <div ref="chatMessagesRef" class="chat-messages q-pa-md" style="flex: 1; overflow-y: auto; min-height: 0;">
          <template v-for="(msg, idx) in messages" :key="idx">
            <!-- Normal Chat Message -->
            <div 
              v-if="!editingMessageIdx.includes(idx)"
              class="q-mb-md"
              :class="msg.role === 'user' ? 'text-right' : 'text-left'"
            >
              <q-badge 
                :color="msg.role === 'user' ? 'primary' : 'secondary'"
                :label="getMessageLabel(msg)"
              />
              <div 
                class="q-mt-xs q-pa-sm rounded-borders"
                :class="msg.role === 'user' ? 'bg-blue-1' : 'bg-grey-2'"
                style="display: inline-block; max-width: 80%;"
                @click="handlePageLinkClick"
              >
                <div v-if="msg.reasoningContent && !isStreaming" class="reasoning-section">
                  <div class="reasoning-toggle" @click="toggleReasoning(idx)">
                    <span class="reasoning-arrow">{{ expandedReasoning[idx] ? '▼' : '▶' }}</span>
                    {{ expandedReasoning[idx] ? 'Hide reasoning' : 'Show reasoning' }}
                  </div>
                  <div v-if="expandedReasoning[idx]" class="reasoning-content">{{ msg.reasoningContent }}</div>
                </div>
                <div v-html="messageDisplayHtml[idx]"></div>
                <div class="q-mt-sm">
                  <q-btn
                    flat
                    dense
                    size="xs"
                    icon="edit"
                    color="grey-8"
                    label="Edit"
                    @click="startEditing(idx)"
                    title="Edit message"
                  />
                </div>
              </div>
            </div>
            
            <!-- Editable Chat Message -->
            <div 
              v-if="editingMessageIdx.includes(idx)"
              class="q-mb-md"
              :class="msg.role === 'user' ? 'text-right' : 'text-left'"
            >
              <q-badge 
                :color="msg.role === 'user' ? 'primary' : 'secondary'"
                :label="getMessageLabel(msg)"
              />
              <div 
                class="q-mt-xs q-pa-sm rounded-borders"
                :class="msg.role === 'user' ? 'bg-blue-1' : 'bg-grey-2'"
                style="display: inline-block; width: 90%; max-width: 90%"
              >
                <textarea 
                  v-model="msg.content" 
                  rows="8"
                  class="full-width q-pa-sm"
                  style="border: 1px solid #ccc; border-radius: 4px; resize: vertical;"
                />
                <div class="edit-buttons q-mt-sm">
                  <q-btn
                    size="sm"
                    icon="save"
                    color="primary"
                    label="Save"
                    @click="saveEditedMessage(idx)"
                  />
                  <q-btn
                    size="sm"
                    icon="close"
                    color="grey-7"
                    label="Cancel"
                    @click="cancelEditing(idx)"
                  />
                  <q-btn
                    size="sm"
                    icon="delete"
                    color="negative"
                    label="Delete Question and Response"
                    @click="confirmDeleteMessage(idx)"
                  />
                </div>
              </div>
            </div>
          </template>
          
          <div v-if="isStreaming" class="text-grey-6">
            <template v-if="streamingReasoning && !reasoningDone">
              <div class="reasoning-section streaming">
                <div class="reasoning-toggle">
                  <q-spinner-dots size="sm" /> Reasoning...
                </div>
                <div ref="streamingReasoningRef" class="reasoning-content">{{ streamingReasoning }}</div>
              </div>
            </template>
            <template v-else-if="reasoningDone">
              <div class="reasoning-section">
                <div class="reasoning-toggle" @click="streamingReasoningExpanded = !streamingReasoningExpanded">
                  <span class="reasoning-arrow">{{ streamingReasoningExpanded ? '▼' : '▶' }}</span>
                  {{ streamingReasoningExpanded ? 'Hide reasoning' : 'Show reasoning' }}
                </div>
                <div v-if="streamingReasoningExpanded" class="reasoning-content">{{ streamingReasoning }}</div>
              </div>
              Generating response... <q-spinner-dots size="sm" />
            </template>
            <template v-else>
              Thinking... <q-spinner-dots size="sm" />
            </template>
          </div>
        </div>
        
        <!-- Delete Confirmation Dialog -->
        <q-dialog v-model="showDeleteDialog" persistent>
          <q-card style="min-width: 350px">
            <q-card-section>
              <div class="text-h6">Delete Messages</div>
            </q-card-section>

            <q-card-section>
              <div class="text-body1">
                <p>Are you sure you want to delete this message?</p>
                <div class="message-preview q-mt-md">
                  <strong>{{ messageToDelete?.role === 'user' ? getUserLabel() : getProviderLabel() }}:</strong>
                  <div class="message-content">{{ messageToDelete?.content?.substring(0, 100) }}{{ (messageToDelete?.content?.length ?? 0) > 100 ? '...' : '' }}</div>
                </div>
                <p v-if="precedingUserMessage" class="text-caption text-grey q-mt-sm">
                  <strong>Note:</strong> This will also delete the preceding user question.
                </p>
              </div>
            </q-card-section>

            <q-card-actions align="right">
              <q-btn flat label="Cancel" color="primary" @click="showDeleteDialog = false" />
              <q-btn flat label="Delete" color="negative" @click="deleteMessageConfirmed" />
            </q-card-actions>
          </q-card>
        </q-dialog>

        <!-- Input Area with Provider Selector -->
        <div class="q-pa-md" style="flex-shrink: 0; border-top: 1px solid #eee;">
          <!-- Save Buttons -->
          <div class="row q-gutter-sm q-mb-sm" v-if="messages.length > 0">
            <div class="col"></div>
            <div class="col-auto">
              <q-btn 
                flat 
                dense 
                size="sm"
                color="primary" 
                label="SAVE LOCALLY"
                icon="save"
                @click="saveLocally"
                :disable="isStreaming || !canSaveLocally"
              />
              <q-btn 
                flat 
                dense 
                size="sm"
                color="secondary" 
                label="SAVE TO GROUP"
                icon="group"
                @click="saveToGroup"
                :disable="isStreaming || !canSaveToGroup"
              />
              <q-btn 
                flat 
                dense 
                size="sm"
                color="primary" 
                :label="`${savedChatCount} SAVED CHATS`"
                icon="history"
                @click="showSavedChats"
                :disable="!props.user?.userId"
              />
            </div>
          </div>
          
          <div class="row q-gutter-sm" style="align-items: center;">
            <!-- v1.4.35: paperclip (attach_file) replaced by a
                 plain "+" and moved to the LEFT of the AI provider
                 dropdown. The entire status-bar row that used to
                 sit below the actions row was removed in the same
                 step (it now had nothing left in it — the wizard
                 icon moved to the Workbook rail in v1.4.34, the
                 My Stuff / userId / SIGN OUT moved to the rail in
                 v1.4.33). The hidden <input type="file"> stays
                 here so triggerFileInput() keeps working without
                 any script changes. -->
            <div class="col-auto">
              <q-btn
                flat
                dense
                round
                icon="add"
                class="text-grey-6"
                :disable="isRequestSent"
                @click="triggerFileInput"
                aria-label="Attach file"
              >
                <q-tooltip v-if="isRequestSent">File import is disabled until your account is approved</q-tooltip>
                <q-tooltip v-else>Attach files to add them to the chat context</q-tooltip>
              </q-btn>
              <input
                ref="fileInput"
                type="file"
                style="display: none"
                @change="handleFileSelect"
              />
            </div>
            <div class="col-auto">
              <q-select
                v-model="selectedProvider"
                :options="providerOptions"
                emit-value
                map-options
                dense
                outlined
                behavior="menu"
                style="min-width: 150px"
              >
                <q-tooltip>Select AI provider: Private AI uses your knowledge base, Public AIs see only chat content</q-tooltip>
              </q-select>
            </div>
            <div class="col">
              <q-input
                v-model="inputMessage"
                label="Type your message"
                outlined
                dense
                :disable="isRequestSent"
                @keyup.enter="sendMessage"
                @focus="clearPresetPrompt"
              >
                <q-tooltip v-if="isRequestSent">Chat is disabled until your account is approved</q-tooltip>
                <q-tooltip v-else>Ask for Patient Summary to add it to the chat context and make it available to public AIs.</q-tooltip>
              </q-input>
            </div>
            <div class="col-auto">
              <q-btn
                color="primary"
                label="Send"
                :disable="!inputMessage || isStreaming || isRequestSent"
                @click="sendMessage"
              >
                <q-tooltip v-if="isRequestSent">Chat is disabled until your account is approved</q-tooltip>
              </q-btn>
            </div>
          </div>
        </div>
        </template>
      </q-card-section>
    </q-card>

    <q-dialog v-model="showAgentSetupDialog" persistent>
      <q-card style="min-width: 560px; max-width: 680px">
        <q-card-section>
          <div class="row items-center">
            <div class="col">
              <div class="text-h6">Setting Up Your MAIA</div>
              <div class="text-caption text-grey-7 q-mt-xs">
                <template v-if="wizardPreparingRecords">
                  {{ wizardPreparingMessage || `Preparing health records for ${props.user?.userId || 'Guest'}. Almost done...` }}
                </template>
                <template v-else>
                  Creating account for <strong>{{ props.user?.userId || 'Guest' }}</strong>. This can take 5 to 60 minutes.
                </template>
              </div>
            </div>
            <q-btn flat round dense icon="close" color="grey-7" @click="dismissWizard" />
          </div>
        </q-card-section>

        <q-card-section class="q-pt-none text-body2">
          <!-- Safari hidden file input -->
          <input
            v-if="props.folderAccessTier === 'safari'"
            ref="safariFolderInputRef"
            type="file"
            webkitdirectory
            multiple
            style="display: none"
            @change="handleSafariFolderSelected"
          />

          <!-- Action button: Choose the patient folder -->
          <div v-if="!setupFolderConnected" class="q-mb-md">
            <!-- Chrome: persistent folder access (+ TEST on localhost) -->
            <template v-if="localFolderSupported">
              <q-btn
                unelevated
                color="primary"
                label="Choose the patient folder"
                icon="folder_open"
                :disable="localFolderAutoRunActive"
                @click="handlePickLocalFolder"
              />
              <q-btn
                v-if="isLocalhost"
                flat
                color="deep-orange"
                label="TEST"
                icon="science"
                class="q-ml-sm"
                :disable="localFolderAutoRunActive || testMode"
                @click="handleTestButton"
              />
            </template>
            <!-- Safari: one-time folder read -->
            <q-btn
              v-else-if="props.folderAccessTier === 'safari'"
              unelevated
              color="primary"
              label="Select your MAIA folder"
              icon="folder_open"
              :disable="localFolderAutoRunActive"
              @click="handlePickSafariFolder"
            />
            <!-- Other browsers: file upload -->
            <q-btn
              v-else
              unelevated
              color="primary"
              label="Upload health files"
              icon="upload_file"
              :disable="isUploadingFile"
              @click="triggerFileInput"
            />
          </div>

          <!-- Progress checklist -->
          <q-list dense>
            <!-- Per-file upload lines (only when folder connected and files found) -->
            <q-item v-for="file in setupChecklistFiles" :key="`setup-file:${file.name}`" dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-spinner v-if="file.status === 'running'" size="sm" color="primary" />
                <q-icon v-else-if="file.status === 'done'" name="check_circle" color="green" size="sm" />
                <q-icon v-else-if="file.status === 'error'" name="error" color="negative" size="sm" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': file.status === 'pending' }">
                  {{ file.name }}
                  <q-chip v-if="file.isAppleHealth" color="blue-6" text-color="white" size="sm" dense class="q-ml-xs">Apple Health</q-chip>
                  <span v-if="file.progress" class="text-caption q-ml-sm" :class="file.status === 'done' ? 'text-green' : 'text-primary'">{{ file.progress }}</span>
                </q-item-label>
              </q-item-section>
            </q-item>

            <!-- Deploy Primary AI Agent -->
            <q-item dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-spinner v-if="!wizardStage1Complete && agentSetupPollingActive" size="sm" color="primary" />
                <q-icon v-else-if="wizardStage1Complete" name="check_circle" color="green" size="sm" />
                <q-icon v-else-if="agentSetupTimedOut" name="error" color="negative" size="sm" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': !wizardStage1Complete && !agentSetupPollingActive }">
                  Deploy {{ wizardPrimaryModelName || 'Primary AI' }} Agent
                  <span v-if="wizardStage1Complete" class="text-green text-caption q-ml-sm">Ready{{ wizardAgentDeployElapsed ? ` (${Math.floor(wizardAgentDeployElapsed / 60)}m ${wizardAgentDeployElapsed % 60}s)` : '' }}</span>
                  <span v-else-if="agentSetupPollingActive" class="text-primary text-caption q-ml-sm">
                    {{ wizardStage1StatusLine }}
                    <span class="text-grey-6">(10 min max)</span>
                  </span>
                  <span v-else-if="agentSetupTimedOut" class="text-negative text-caption q-ml-sm">Timed out</span>
                </q-item-label>
              </q-item-section>
            </q-item>

            <!-- Deploy Secondary AI Agent -->
            <q-item v-if="wizardStage1Complete" dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-spinner v-if="wizardSecondaryDeploying" size="sm" color="primary" />
                <q-icon v-else-if="gptAgentReady" name="check_circle" color="green" size="sm" />
                <q-icon v-else-if="wizardSecondaryFailed" name="warning" color="orange" size="sm" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label>
                  Deploy {{ labelForProfileKey('gpt') || 'Secondary AI' }} Agent
                  <span v-if="gptAgentReady" class="text-green text-caption q-ml-sm">Ready{{ wizardSecondaryElapsed ? ` (${wizardSecondaryElapsed}s)` : '' }}</span>
                  <span v-else-if="wizardSecondaryDeploying" class="text-primary text-caption q-ml-sm">
                    Deploying... {{ wizardSecondaryElapsed ? `(${wizardSecondaryElapsed}s)` : '' }}
                    <span class="text-grey-6">(~30s)</span>
                  </span>
                  <span v-else-if="wizardSecondaryFailed" class="text-orange text-caption q-ml-sm">Failed</span>
                </q-item-label>
              </q-item-section>
            </q-item>

            <!-- Index Knowledge Base -->
            <q-item v-if="setupChecklistFiles.length > 0 || stage3HasFiles" dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-spinner v-if="stage3IndexingActive" size="sm" color="primary" />
                <q-icon v-else-if="indexingStatus?.phase === 'complete'" name="check_circle" color="green" size="sm" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': !stage3IndexingActive && indexingStatus?.phase !== 'complete' }">
                  Index Knowledge Base
                  <span v-if="stage3IndexingActive" class="text-primary text-caption q-ml-sm">
                    {{ stage2StatusDisplay.tokens !== '0' ? `${stage2StatusDisplay.tokens} tokens` : 'Indexing...' }}
                    {{ stage3IndexingStartedAt ? `(${formatElapsed(stage3IndexingStartedAt)})` : '' }}
                    <span class="text-grey-6">(30 min max)</span>
                  </span>
                  <span v-else-if="indexingStatus?.phase === 'complete'" class="text-green text-caption q-ml-sm">
                    {{ stage2StatusDisplay.files }} files, {{ stage2StatusDisplay.tokens }} tokens{{ (stage3IndexingStartedAt && stage3IndexingCompletedAt) ? ` (${formatElapsed(stage3IndexingStartedAt, stage3IndexingCompletedAt)})` : '' }}
                  </span>
                </q-item-label>
              </q-item-section>
            </q-item>

            <!-- Draft Patient Summary (always visible) -->
            <q-item dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-icon v-if="wizardDraftPsStatus === 'done' || preGeneratedSummary" name="check_circle" color="green" size="sm" />
                <q-spinner v-else-if="wizardDraftPsStatus === 'running'" size="sm" color="primary" />
                <q-icon v-else-if="wizardDraftPsStatus === 'failed'" name="warning" color="orange" size="sm" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': wizardDraftPsStatus === 'idle' && !preGeneratedSummary }">
                  Draft Patient Summary
                  <span v-if="wizardDraftPsStatus === 'done' || (preGeneratedSummary && wizardDraftPsStatus !== 'running')" class="text-green text-caption q-ml-sm">Generated{{ (wizardDraftPsStartedAt && wizardDraftPsCompletedAt) ? ` (${formatElapsed(wizardDraftPsStartedAt, wizardDraftPsCompletedAt)})` : '' }}</span>
                  <span v-else-if="wizardDraftPsStatus === 'running'" class="text-primary text-caption q-ml-sm">
                    {{ wizardDraftPsModel || 'AI' }} working...
                    {{ wizardDraftPsStartedAt ? formatElapsed(wizardDraftPsStartedAt) : '' }}
                    <span class="text-grey-6">(20 min max)</span>
                  </span>
                  <span v-else-if="wizardDraftPsStatus === 'failed'" class="text-orange text-caption q-ml-sm">
                    Failed
                  </span>
                </q-item-label>
              </q-item-section>
            </q-item>

            <!-- Medication Worksheets (always visible) -->
            <q-item dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-icon v-if="wizardCurrentMedications" name="check_circle" color="green" size="sm" />
                <q-spinner v-else-if="wizardPreparingRecords && wizardDraftPsStatus !== 'running'" size="sm" color="primary" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': !wizardCurrentMedications && !wizardPreparingRecords }">
                  Medication Worksheets
                  <span v-if="wizardCurrentMedications" class="text-green text-caption q-ml-sm">Verified</span>
                  <span v-else-if="wizardFlowPhase === 'medications'" class="text-primary text-caption q-ml-sm">Verify in My Lists</span>
                </q-item-label>
              </q-item-section>
            </q-item>

            <!-- Verify Patient Summary (always visible, after medications) -->
            <q-item dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-icon v-if="wizardPatientSummary" name="check_circle" color="green" size="sm" />
                <q-spinner v-else-if="wizardFlowPhase === 'summary'" size="sm" color="primary" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': !wizardPatientSummary && wizardFlowPhase !== 'summary' }">
                  Patient Summary
                  <span v-if="wizardPatientSummary" class="text-green text-caption q-ml-sm">Verified</span>
                  <span v-else-if="wizardFlowPhase === 'summary'" class="text-primary text-caption q-ml-sm">Verify in My Lists</span>
                </q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
          <!-- (Old transient "Active phase status" line removed — the
               persistent footer below now covers the whole flow.) -->
        </q-card-section>

        <!-- Test results panel (localhost only, shown below wizard progress) -->
        <q-card-section v-if="testMode && testLogLines.length > 0" class="q-pt-none">
          <div class="q-pa-sm" style="border: 1px solid #ef6c00; border-radius: 6px; background: #fff8e1;">
            <div class="text-subtitle2 q-mb-xs" style="color: #ef6c00;">
              <q-icon name="science" size="sm" class="q-mr-xs" />
              TEST Mode — Auto-Verify
            </div>
            <div v-for="(line, i) in testLogLines" :key="i" class="text-caption" :style="{ color: line.ok ? '#2e7d32' : '#c62828' }">
              {{ line.ok ? '\u2713' : '\u2717' }} {{ line.text }}
            </div>
            <pre v-if="testFinalOutput" class="q-mt-sm text-caption" style="white-space: pre-wrap; max-height: 300px; overflow-y: auto; background: #fff; padding: 6px; border-radius: 4px; font-family: monospace; font-size: 11px;">{{ testFinalOutput }}</pre>
          </div>
        </q-card-section>

        <!-- Persistent running-status footer (mirrors the Restore wizard).
             Driven by a computed so it stays accurate through upload,
             agent deploy, KB indexing and the verify steps — instead of
             the old localFolderAutoRunActive line that vanished the
             moment indexing was kicked off. -->
        <q-card-section v-if="setupFolderConnected" class="q-pt-none">
          <div
            class="row items-center text-caption text-grey-7"
            style="border-top: 1px solid #ececec; padding-top: 8px"
          >
            <q-icon
              v-if="setupAllComplete"
              name="check_circle" color="green" size="14px" class="q-mr-sm"
            />
            <q-icon
              v-else-if="agentSetupTimedOut && !wizardStage1Complete"
              name="error" color="negative" size="14px" class="q-mr-sm"
            />
            <q-spinner v-else size="14px" color="primary" class="q-mr-sm" />
            <span>{{ wizardStatusLine }}</span>
          </div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn
            v-if="wizardStage1Complete && (indexingStatus?.phase === 'complete' || !stage3HasFiles) && !wizardPreparingRecords"
            unelevated label="Continue" color="primary"
            @click="dismissWizard"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Restore Complete sub-dialog (shown after restore flow) -->
    <q-dialog v-model="showRestoreCompleteDialog" persistent>
      <q-card style="min-width: 480px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Account Restored</div>
        </q-card-section>
        <q-card-section class="text-body2">
          Your account has been restored. The Patient Summary, Private AI knowledge base, and Saved Chats are available. Deep links that were not accessible during account dormancy are available again.
          <br /><br />
          Your private information will be in the cloud until you sign out again.
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="OK" color="primary" v-close-popup />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Wizard 60-minute timeout modal -->
    <q-dialog v-model="wizardTimeoutModalVisible" persistent>
      <q-card style="min-width: 480px; max-width: 600px">
        <q-card-section>
          <div class="text-h6">Setup Taking Longer Than Expected</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>Your MAIA setup has been running for over 60 minutes. This may indicate an issue that needs attention.</p>
          <p>A detailed setup log (<strong>maia-log.pdf</strong>) has been saved to your MAIA folder. Please email it to <a href="mailto:info@trustee.ai">info@trustee.ai</a> for tech support.</p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="OK" color="primary" @click="wizardTimeoutModalVisible = false" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <q-dialog v-model="showPrivateUnavailableDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Private AI Unavailable</div>
        </q-card-section>
        <q-card-section class="text-body2">
          Your Private AI agent is not available. You may access the public AIs but they will not have any access to your health records knowledge base.
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="OK" color="primary" @click="showPrivateUnavailableDialog = false" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- PDF Viewer Modal -->
    <PdfViewerModal
      v-model="showPdfViewer"
      :file="viewingFile ? {
        fileUrl: viewingFile.fileUrl,
        bucketKey: viewingFile.bucketKey,
        originalFile: viewingFile.originalFile ?? undefined,
        name: viewingFile.name
      } : undefined"
      :initial-page="pdfInitialPage"
    />

    <!-- Text/Markdown Viewer Modal -->
    <TextViewerModal
      v-model="showTextViewer"
      :file="viewingFile ? {
        fileUrl: viewingFile.fileUrl,
        bucketKey: viewingFile.bucketKey,
        originalFile: viewingFile.originalFile ?? undefined,
        name: viewingFile.name,
        content: viewingFile.content,
        type: viewingFile.type
      } : undefined"
    />

    <!-- Saved Chats Modal -->
    <SavedChatsModal
      v-model="showSavedChatsModal"
      :currentUser="props.user?.userId || ''"
      :is-deep-link-user="isDeepLink"
      @chat-selected="handleChatSelected"
      @chat-deleted="handleChatDeleted"
    />

    <!-- My Stuff Dialog -->
    <MyStuffDialog
      ref="myStuffDialogRef"
      v-model="showMyStuffDialog"
      :userId="props.user?.userId || ''"
      :initial-tab="myStuffInitialTab"
      :messages="messages"
      :original-messages="trulyOriginalMessages.length > 0 ? trulyOriginalMessages : originalMessages"
      :rehydration-files="props.rehydrationFiles || []"
      :rehydration-active="props.rehydrationActive"
      :wizard-active="wizardActive"
      :meds-needs-verify="medsNeedsVerify"
      :show-close-prompt="showWorkbookClosePrompt"
      :saved-chat-count="savedChatCount"
      @chat-selected="handleChatSelected"
      @indexing-started="handleIndexingStarted"
      @indexing-status-update="handleIndexingStatusUpdate"
      @indexing-finished="handleIndexingFinished"
      @files-archived="handleFilesArchived"
      @messages-filtered="handleMessagesFiltered"
      @diary-posted="handleDiaryPosted"
      @reference-file-added="handleReferenceFileAdded"
      @current-medications-saved="handleCurrentMedicationsSaved"
      @medications-offered="handleMedicationsOffered"
      @patient-summary-saved="handlePatientSummarySaved"
      @patient-summary-verified="handlePatientSummaryVerified"
      @show-patient-summary="handleMyStuffShowSummary"
      @rehydration-file-removed="handleRehydrationFileRemoved"
      @rehydration-complete="handleRehydrationComplete"
      @file-added-to-kb="handleFileAddedToKb"
      @tab-opened="handleMyStuffTabOpened"
      @sign-out-requested="handleSignOut"
      @wizard-requested="() => { wizardDismissed = false; showAgentSetupDialog = true; }"
      @provisioning-event="(data: Record<string, any>) => logProvisioningEvent(data)"
      v-if="canAccessMyStuff"
    />

    <!-- Needs indexing prompt: agent exists, files exist, but KB not attached/indexed -->
    <q-dialog v-model="showNeedsIndexingPrompt" persistent>
      <q-card style="min-width: 420px; max-width: 520px">
        <q-card-section>
          <div class="text-h6">Index Your Records</div>
        </q-card-section>
        <q-card-section class="q-pt-none text-body2">
          You have imported records that are not indexed for access by your Private AI.
        </q-card-section>
        <q-card-actions align="right" class="q-gutter-sm">
          <q-btn
            flat
            label="NOT YET"
            color="grey-8"
            @click="needsIndexingPromptDismissedThisSession = true; showNeedsIndexingPrompt = false"
          />
          <q-btn
            unelevated
            label="INDEX NOW"
            color="primary"
            @click="handleNeedsIndexingIndexNow"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Document Chooser Dialog -->
    <q-dialog v-model="showDocumentChooser" persistent>
      <q-card style="min-width: 400px">
        <q-card-section>
          <div class="text-h6">Select Document</div>
          <div class="text-caption text-grey q-mt-sm">
            <span v-if="loadingUserFiles">Loading documents...</span>
            <span v-else-if="uploadedFiles.filter(f => f.type === 'pdf').length > 0 || availableUserFiles.length > 0">
              Please select which document to view.
            </span>
            <span v-else>No PDF documents available.</span>
          </div>
        </q-card-section>

        <q-card-section>
          <q-list v-if="!loadingUserFiles">
            <!-- Show PDFs from current chat first -->
            <q-item
              v-for="file in uploadedFiles.filter(f => f.type === 'pdf')"
              :key="file.id"
              clickable
              v-ripple
              @click="handleDocumentSelected(file)"
            >
              <q-item-section avatar>
                <q-icon name="description" color="primary" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ file.name }}</q-item-label>
                <q-item-label caption>From current chat</q-item-label>
              </q-item-section>
            </q-item>
            
            <!-- Show PDFs from user account -->
            <q-item
              v-for="file in availableUserFiles"
              :key="file.bucketKey"
              clickable
              v-ripple
              @click="handleDocumentSelected(file)"
            >
              <q-item-section avatar>
                <q-icon name="description" color="secondary" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ file.fileName }}</q-item-label>
                <q-item-label caption>From your files</q-item-label>
              </q-item-section>
            </q-item>
            
            <q-item v-if="uploadedFiles.filter(f => f.type === 'pdf').length === 0 && availableUserFiles.length === 0">
              <q-item-section>
                <q-item-label class="text-grey">No PDF documents found</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
          
          <div v-else class="text-center q-pa-md">
            <q-spinner-dots size="md" />
          </div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat label="Cancel" color="primary" @click="closeDocumentChooser" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Request Sent Modal -->
    <q-dialog v-model="showRequestSentModal" persistent>
      <q-card>
        <q-card-section>
          <div class="text-h6">Request Sent</div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <p>Request sent. Approval can take hours or days. Reload the app when contacted or if you want to check.</p>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat label="OK" color="primary" @click="showRequestSentModal = false" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Post-Indexing: Offer to update Patient Summary -->
    <q-dialog v-model="showPostIndexingSummaryPrompt" persistent>
      <q-card style="min-width: 420px; max-width: 540px">
        <q-card-section>
          <div class="text-h6">Knowledge Base Updated</div>
        </q-card-section>
        <q-card-section class="q-pt-none text-body2">
          You have changed the files in your knowledge base. Would you like to update the Patient Summary?
        </q-card-section>
        <q-card-actions align="right" class="q-gutter-sm">
          <q-btn
            flat
            label="Not yet"
            color="grey-8"
            @click="showPostIndexingSummaryPrompt = false; postIndexingSummaryDismissedThisSession = true"
          />
          <q-btn
            unelevated
            label="Update the Patient Summary"
            color="primary"
            @click="handlePostIndexingUpdateSummary"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Shown after a manual "patient summary" chat request completes -->
    <q-dialog v-model="showNewSummaryDialog" persistent>
      <q-card style="min-width: 420px; max-width: 540px">
        <q-card-section>
          <div class="text-h6">New Patient Summary detected</div>
        </q-card-section>
        <q-card-section class="q-pt-none text-body2">
          A new Patient Summary was generated and saved. Would you like to:
        </q-card-section>
        <q-card-actions align="right" class="q-gutter-sm">
          <q-btn
            flat
            label="Continue with chat only"
            color="grey-8"
            @click="showNewSummaryDialog = false"
          />
          <q-btn
            unelevated
            label="Open Patient Summary tab"
            color="primary"
            @click="showNewSummaryDialog = false; myStuffInitialTab = 'summary'; showMyStuffDialog = true;"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import { useQuasar } from 'quasar';
import PdfViewerModal from './PdfViewerModal.vue';
import TextViewerModal from './TextViewerModal.vue';
import SavedChatsModal from './SavedChatsModal.vue';
import MyStuffDialog from './MyStuffDialog.vue';
import { jsPDF } from 'jspdf';
import MarkdownIt from 'markdown-it';
import { processFileNCitations } from '../utils/fileNCitations';
import {
  isFileSystemAccessSupported,
  pickLocalFolder,
  reconnectLocalFolder,
  reconnectLocalFolderWithGesture,
  listFolderFiles,
  writeFileToFolder,
  readStateFile,
  writeStateFile,
  writeWeblocFile,
  type MaiaFileEntry,
  type MaiaState
} from '../utils/localFolder';
import packageJson from '../../package.json';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  name?: string; // legacy field for compatibility
  authorId?: string;
  authorLabel?: string;
  authorType?: 'user' | 'assistant';
  providerKey?: string;
  reasoningContent?: string;
}

interface User {
  userId: string;
  displayName: string;
  isDeepLink?: boolean;
  isTemporary?: boolean;
  isAdmin?: boolean;
}

interface DeepLinkInfo {
  shareId: string | null;
  chatId?: string | null;
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: 'text' | 'pdf' | 'markdown';
  content: string;
  transcript?: string;
  originalFile: File | null;
  bucketKey?: string;
  bucketPath?: string;
  fileUrl?: string;
  uploadedAt: Date;
  isReference?: boolean;
}

interface Props {
  user?: User | null;
  isDeepLinkUser?: boolean;
  deepLinkInfo?: DeepLinkInfo | null;
  restoreChatState?: {
    messages: any[];
    uploadedFiles: any[];
    inputMessage: string;
    providerKey: string;
    providerLabel: string;
    savedChatId?: string | null;
    savedChatShareId?: string | null;
  } | null;
  rehydrationFiles?: any[] | null;
  rehydrationActive?: boolean;
  restoreActive?: boolean;
  suppressWizard?: boolean;
  folderAccessTier?: 'chrome' | 'safari' | 'basic';
  passkeyWithoutFolder?: boolean;
}

interface SignOutSnapshot {
  currentChat: {
    messages: any[];
    uploadedFiles: any[];
    inputMessage: string;
    providerKey: string;
    providerLabel: string;
    savedChatId?: string | null;
    savedChatShareId?: string | null;
  };
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'sign-out': [SignOutSnapshot];
  'restore-applied': [];
  'rehydration-complete': [payload: { hasInitialFile: boolean }];
  'rehydration-file-removed': [payload: { bucketKey?: string; fileName?: string }];
  'update:deepLinkInfo': [DeepLinkInfo | null];
  'local-folder-connected': [payload: { handle: FileSystemDirectoryHandle; folderName: string }];
  'session-dirty': [];
  'wizard-complete': [];
  'test-setup-complete': [payload: { verification: any; folderHandle: FileSystemDirectoryHandle }];
}>();

const $q = useQuasar();

const providers = ref<string[]>([]);
const selectedProvider = ref<string>('Private AI');
const messages = ref<Message[]>([]);
const originalMessages = ref<Message[]>([]); // Store original unfiltered messages for privacy filtering
const trulyOriginalMessages = ref<Message[]>([]); // Store truly original messages that never get overwritten (for filtering)
const inputMessage = ref('');
const isStreaming = ref(false);
const streamingReasoning = ref('');
const reasoningDone = ref(false);
const streamingReasoningExpanded = ref(false);
const streamingReasoningRef = ref<HTMLElement | null>(null);
const expandedReasoning = ref<Record<number, boolean>>({});
const toggleReasoning = (idx: number) => {
  expandedReasoning.value[idx] = !expandedReasoning.value[idx];
};
const uploadedFiles = ref<UploadedFile[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const isUploadingFile = ref(false);
const showPdfViewer = ref(false);
const showTextViewer = ref(false);
const viewingFile = ref<UploadedFile | null>(null);
const pdfInitialPage = ref<number | undefined>(undefined);
const showSavedChatsModal = ref(false);
const savedChatCount = ref(0);
const showMyStuffDialog = ref(false);
const showWorkbookClosePrompt = ref(false);
const myStuffInitialTab = ref<string>('files');
const myStuffDialogRef = ref<InstanceType<typeof MyStuffDialog> | null>(null);

/** Request MyStuffDialog to generate or update the patient summary.
 *  Replaces the old requestAction prop — calls exposed methods directly via ref. */
const requestMyStuffSummaryAction = (action: 'generate-summary' | 'update-summary-meds', medsText?: string) => {
  nextTick(() => {
    if (myStuffDialogRef.value) {
      myStuffDialogRef.value.wizardGenerateSummary(action, medsText);
    }
  });
};
const contextualTip = ref('Loading...');
const editingMessageIdx = ref<number[]>([]);
const editingOriginalContent = ref<Record<number, string>>({});
const showDeleteDialog = ref(false);
const messageToDelete = ref<Message | null>(null);
const precedingUserMessage = ref<Message | null>(null);
const chatMessagesRef = ref<HTMLElement | null>(null);
const showDocumentChooser = ref(false);
const pendingPageLink = ref<{ pageNum: number; bucketKey?: string } | null>(null);
const availableUserFiles = ref<Array<{ fileName: string; bucketKey: string; fileType?: string }>>([]);
const loadingUserFiles = ref(false);
const showAgentSetupDialog = ref(false);
const showNeedsIndexingPrompt = ref(false);
const showPostIndexingSummaryPrompt = ref(false);
// Shown after a MANUAL "patient summary" chat request completes (not
// the prefilled-default SEND), offering to jump to the Patient Summary
// tab where the freshly-generated summary was just saved.
const showNewSummaryDialog = ref(false);
/** Once the user dismisses the post-indexing "Update Patient Summary?" prompt, do not show again this session. */
const postIndexingSummaryDismissedThisSession = ref(false);
/** Once the user dismisses "Index your records" with NOT YET, do not show it again this session. */
const needsIndexingPromptDismissedThisSession = ref(false);
const agentSetupStatus = ref('');
const agentSetupElapsed = ref(0);
const agentSetupTimedOut = ref(false);
const agentSetupPollingActive = ref(false);
let agentSetupTimer: ReturnType<typeof setInterval> | null = null;
const wizardOtherFilesCount = ref(0);
const wizardSlideIndex = ref(0);
const wizardHasFilesInKB = ref(false);
const wizardCurrentMedications = ref(false);
const wizardPatientSummary = ref(false);
const wizardAgentReady = ref(false);
const wizardStage1Complete = ref(false);
// Secondary "Private AI (GPT)" provisioning state (variable kept as
// `gptAgentReady` for historical reasons — profile key is 'gpt'). Setup
// gates completion on this so BOTH Private AIs exist before the wizard
// finishes.
const gptAgentReady = ref(false);
const wizardPreparingStartedAt = ref<number | null>(null);
// Detailed wizard sub-phase tracking for the preparation phase UI
const wizardPrimaryModelName = ref<string | null>(null);   // e.g. "Kimi K2.5"
const wizardSecondaryDeploying = ref(false);
const wizardSecondaryElapsed = ref(0);
const wizardSecondaryFailed = ref(false);
let wizardSecondaryTimer: ReturnType<typeof setInterval> | null = null;
const wizardDraftPsStatus = ref<'idle' | 'running' | 'done' | 'failed'>('idle');
const wizardDraftPsStartedAt = ref<number | null>(null);
const wizardDraftPsCompletedAt = ref<number | null>(null);
const wizardDraftPsModel = ref<string | null>(null);        // which model is generating
const wizardAgentDeployElapsed = ref<number | null>(null);
const wizardUploadIntent = ref<'other' | 'restore' | null>(null);
const wizardMessages = ref<Record<number, string>>({});
const wizardIntroLines = ref<string[]>([]);
const wizardIntroContainer = ref<HTMLElement | null>(null);
const wizardInlineDots = ref<HTMLElement | null>(null);
const wizardDismissed = ref(false);
// Userid for which a 'setup-started' provisioning event has already
// been logged this session (dedupe; see the showAgentSetupDialog watch).
const setupStartedLoggedForUser = ref<string | null>(null);
/** Counts how many times the user has dismissed (closed) MyStuff during a guided flow phase.
 *  After 2 dismissals in the same phase, the phase is skipped and the wizard advances. */
const guidedFlowDismissCount = ref(0);
const appleExportFooterSnippet = 'This summary displays certain health information made available to you by your healthcare provider and may not completely';
const appleExportFooterNormalized = appleExportFooterSnippet.toLowerCase().replace(/\s+/g, ' ').trim();
const stage3Checked = computed(() =>
  !wizardRestoreActive.value && (wizardStage2Complete.value || wizardCurrentMedications.value || wizardStage2NoDevice.value)
);
const showPrivateUnavailableDialog = ref(false);
/** Becomes true after first refreshWizardState (or immediately for deep-link). Gates spinner and "Private AI unavailable" modal. */
const initialLoadComplete = ref(false);
const wizardStage2Complete = ref(false);
const wizardStage3Complete = ref(false);
const wizardStage2Pending = ref(false);
const stage3LastImportedName = ref<string | null>(null);
const wizardIntroBodyHtml = computed(() => {
  if (wizardIntroLines.value.length === 0) {
    return '';
  }
  let firstFound = false;
  const lines: string[] = [];
  for (const line of wizardIntroLines.value) {
    if (!firstFound && line.trim().length > 0) {
      firstFound = true;
      continue;
    }
    lines.push(line);
  }
  const body = lines.join('\n');
  return body.trim().length > 0 ? markdownParser.render(body) : '';
});
const positionWizardInlineDots = async () => {
  if (wizardSlideIndex.value !== 0) return;
  await nextTick();
  const container = wizardIntroContainer.value;
  const dots = wizardInlineDots.value;
  if (!container || !dots) return;
  const lastListItem = container.querySelector('li:last-of-type');
  if (lastListItem) {
    lastListItem.appendChild(dots);
    return;
  }
  container.appendChild(dots);
};
const wizardUserStorageKey = computed(() => props.user?.userId ? `wizard-completion-${props.user.userId}` : null);
const wizardStage2NoDeviceKey = computed(() => props.user?.userId ? `wizardStage2NoDevice-${props.user.userId}` : null);
const wizardAgentSetupStartedKey = (userId: string | undefined) => userId ? `wizard_agent_setup_started_${userId}` : null;
const wizardStage3IndexingStartedKey = (userId: string | undefined) => userId ? `wizard_stage3_indexing_started_${userId}` : null;
const wizardRestoreActive = computed(() => !!props.rehydrationActive && (Array.isArray(props.rehydrationFiles) ? props.rehydrationFiles.length > 0 : false));
const showRestoreCompleteDialog = ref(false);
const restoreIndexingActive = ref(false);
const restoreIndexingQueued = ref(false);
const wizardRestoreTargetName = ref<string | null>(null);
const wizardStage2NoDevice = ref(false);

// ── Localhost detection ───────────────────────────────────────────
const isLocalhost = ref(typeof window !== 'undefined' && window.location.hostname === 'localhost');

// ── Setup-Restore Test state (auto-pilot mode) ──────────────────
/** When true, wizard auto-verifies at every choice point and emits test events to App.vue. */
const testMode = ref(false);
const testLogLines = ref<Array<{ text: string; ok: boolean }>>([]);
const testFinalOutput = ref('');
const testSetupVerification = ref<any>(null); // TabVerification from after setup

const addTestLog = (text: string, ok: boolean = true) => {
  testLogLines.value.push({ text, ok });
};

const setTestFinalOutput = (text: string) => {
  testFinalOutput.value = text;
};

// ── Local Folder state (File System Access API) ─────────────────
const localFolderSupported = ref(false);
const localFolderHandle = ref<FileSystemDirectoryHandle | null>(null);
const localFolderName = ref<string | null>(null);
const localFolderFiles = ref<MaiaFileEntry[]>([]);
const localFolderAutoRunActive = ref(false);
const localFolderAutoRunPhase = ref<string>('');
/** 60-minute timeout — show failure modal asking user to email setup log to tech support. */
const wizardTimeoutModalVisible = ref(false);
let wizardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
/** Guided wizard flow phase. Starts 'done' to avoid re-entering guided flow on reload;
 *  set to 'running' only when the wizard is actively running for the first time. */
const wizardFlowPhase = ref<'running' | 'medications' | 'summary' | 'done'>('done');
/** Pre-generated Patient Summary text created at the start of the guided flow.
 *  Generated in the background so it's available if Lists needs Current Medications. */
const preGeneratedSummary = ref<string | null>(null);
/** True while the wizard is generating Patient Summary and preparing to open My Lists.
 *  Keeps the wizard dialog visible so the user doesn't see a zombie chat. */
const wizardPreparingRecords = ref(false);
const wizardPreparingMessage = ref<string>('');

// ── Provisioning log ────
// Coalesce duplicate log events (two code paths occasionally emit the same
// milestone within a few seconds — e.g. kb-indexed, summary-saved, restore-complete).
const lastLoggedEventAt: Record<string, number> = {};
const COALESCE_WINDOW_MS: Record<string, number> = {
  // kb-indexed fires from two code paths (poll + phase watcher) and the
  // phase watcher can re-fire long after indexing actually finished if
  // indexingStatus.phase is re-set to 'complete' by a status refresh.
  // 15-min window is too long (Setup + Restore both emit in the same
  // session), so we also key the coalesce by tokens+fileCount below so
  // a genuine re-index with a different count still gets logged.
  'kb-indexed': 15 * 60 * 1000,
  'summary-saved': 3000,
  'summary-verified': 3000,
  'summary-generated': 3000,
  'medications-saved': 10000,
  'restore-complete': 3000,
  'setup-complete': 3000,
  'test-started': 3000,
  'test-completed': 3000
};

/** Some events (kb-indexed) legitimately recur with different payloads in the
 *  same session; we want to suppress duplicates of the SAME payload but allow
 *  a different payload through. For those, the coalesce key includes data fields. */
const coalesceKeyFor = (eventData: Record<string, any>): string => {
  const evt = String(eventData.event || '');
  if (evt === 'kb-indexed') {
    return `${evt}|${eventData.tokens ?? 0}|${eventData.fileCount ?? 0}`;
  }
  return evt;
};

const logProvisioningEvent = async (eventData: Record<string, any>) => {
  if (!props.user?.userId) return;
  const evt = String(eventData.event || '');
  // Reset the coalesce tracker at the start of a new Setup/Restore section
  // so legitimate re-emissions (e.g. kb-indexed in Setup then again in Restore)
  // aren't suppressed across sections.
  if (evt === 'setup-started' || evt === 'restore-started') {
    for (const k of Object.keys(lastLoggedEventAt)) delete lastLoggedEventAt[k];
  }
  const window = COALESCE_WINDOW_MS[evt];
  if (window) {
    const key = coalesceKeyFor(eventData);
    const last = lastLoggedEventAt[key] || 0;
    const now = Date.now();
    if (now - last < window) {
      return;
    }
    lastLoggedEventAt[key] = now;
  }
  let delivered = false;
  try {
    const resp = await fetch('/api/provisioning-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.user.userId, ...eventData })
    });
    // Server returns 200 + {success:false} when it couldn't persist
    // (so the browser logs no error line); treat that as not delivered.
    if (resp.ok) {
      const body = await resp.json().catch(() => ({}));
      delivered = body?.success !== false;
    }
  } catch (err) {
    console.warn('Failed to log provisioning event:', eventData.event, err);
  }
  if (!delivered) {
    // Session likely gone (sign-out / destroy). Buffer so the next
    // maia-log.pdf still shows this event — especially errors/warnings.
    try {
      const { bufferLogEvent } = await import('../utils/localFolder');
      bufferLogEvent({ userId: props.user.userId, ...eventData });
    } catch { /* ignore */ }
  }
  // Regenerate maia-log.pdf so the local folder always reflects the latest events
  void generateSetupLogPdf();
};

// ── Safari / basic fallback folder state ────────────────────────
/** Files collected via webkitdirectory input (Safari) or single-file input (basic). */
const safariFolderFiles = ref<File[]>([]);
const safariFolderInputRef = ref<HTMLInputElement | null>(null);
/** Name of the folder selected via webkitdirectory (extracted from webkitRelativePath). */
const safariFolderName = ref<string | null>(null);
/** True when we recovered safariFolderName from localStorage but have no live folder handle/files.
 *  Shows a prompt asking the user to re-select the folder to continue. */
const safariNeedsReselect = ref(false);

const wizardStage1StatusLine = computed(() => {
  if (wizardStage1Complete.value) return 'Ready to chat';
  const statusSuffix = agentSetupStatus.value ? ` • ${agentSetupStatus.value}` : '';
  if (agentSetupElapsed.value) {
    return `${Math.floor(agentSetupElapsed.value / 60)}m ${agentSetupElapsed.value % 60}s${statusSuffix}`;
  }
  return `<elapsed time>${statusSuffix}`;
});
const wizardStage2FileName = ref<string | null>(null);
const wizardStage3Files = ref<Array<{ name: string; isAppleHealth?: boolean; inKnowledgeBase?: boolean; bucketKey?: string; pendingKbAdd?: boolean }>>([]);
const wizardKbIndexedKeys = ref<string[]>([]);
const wizardKbTogglePending = ref<Set<string>>(new Set());
const wizardAutoCheckedKeys = ref<Set<string>>(new Set());
const stage2StatusDisplay = computed(() => {
  const isIndexing = indexingStatus.value?.phase === 'indexing' || indexingStatus.value?.phase === 'indexing_started';
  const files = indexingStatus.value?.filesIndexed ?? stage3DisplayFiles.value.length;
  const tokens = indexingStatus.value?.tokens ?? wizardKbTotalTokens.value ?? '0';
  const hasCompleted = indexingStatus.value?.phase === 'complete' || (!!wizardKbTotalTokens.value && !isIndexing && stage3HasFiles.value);
  if (!stage3HasFiles.value && !isIndexing && !hasCompleted) {
    return { show: false, text: '', files: 0, tokens: '0', active: false, completed: false };
  }
  if (isIndexing) {
    const elapsed = stage3IndexingStartedAt.value ? ` (${formatElapsed(stage3IndexingStartedAt.value)})` : '';
    return { show: true, text: `Indexing in-progress. Could take 5 to 60 minutes.${elapsed}`, files, tokens, active: true, completed: false };
  }
  if (hasCompleted) {
    return { show: true, text: 'Indexing complete.', files, tokens, active: false, completed: true };
  }
  return { show: true, text: 'Indexing status pending.', files, tokens, active: false, completed: false };
});
const stage3PendingUploadName = ref<string | null>(null);
const wizardKbName = ref<string | null>(null);
const wizardKbTotalTokens = ref<string | null>(null);
const wizardKbIndexedCount = ref<number | null>(null);
const stage3DisplayFiles = computed(() => {
  if (wizardRestoreActive.value) {
    const files = Array.isArray(props.rehydrationFiles) ? props.rehydrationFiles : [];
    return files
      .filter((file: { isInitial?: boolean }) => !file?.isInitial)
      .map((file: { fileName?: string; bucketKey?: string; restored?: boolean }) => ({
        name: getFileNameFromEntry(file),
        needsRestore: true,
        isAppleHealth: false,
        inKnowledgeBase: !!file.restored,
        bucketKey: file.bucketKey || null,
        pendingKbAdd: false,
        restored: !!file.restored
      }))
      .filter((entry: { name: string }) => !!entry.name);
  }
  const seen = new Set<string>();
  return wizardStage3Files.value
    .filter(entry => !!entry.name)
    .filter(entry => {
      if (seen.has(entry.name)) return false;
      seen.add(entry.name);
      return true;
    })
    .map(entry => ({
      name: entry.name,
      needsRestore: false,
      isAppleHealth: entry.isAppleHealth,
      inKnowledgeBase: !!entry.inKnowledgeBase,
      bucketKey: entry.bucketKey || null,
      pendingKbAdd: !!entry.pendingKbAdd
    }));
});
const stage3HasFiles = computed(() => stage3DisplayFiles.value.length > 0);



const persistWizardCompletion = () => {
  if (!wizardUserStorageKey.value) return;
  localStorage.setItem(
    wizardUserStorageKey.value,
    JSON.stringify({
      stage2Complete: wizardStage3Complete.value,
      stage3Complete: stage3Checked.value,
      stage4Complete: wizardPatientSummary.value
    })
  );
};

// Track owner's deep link Private AI access setting
const ownerAllowDeepLinkPrivateAI = ref<boolean | null>(null);

// Track initial chat state for change detection
const currentSavedChatId = ref<string | null>(null);
const currentSavedChatShareId = ref<string | null>(null);
const lastLocalSaveSnapshot = ref<string | null>(null);
const lastGroupSaveSnapshot = ref<string | null>(null);
const hasLoadedDeepLinkChat = ref(false);

const isDeepLink = computed(() => !!props.isDeepLinkUser);
const deepLinkInfoLocal = ref<DeepLinkInfo | null>(props.deepLinkInfo || null);

watch(
  () => props.deepLinkInfo,
  (newInfo) => {
    deepLinkInfoLocal.value = newInfo || deepLinkInfoLocal.value;
  }
);

const deepLinkShareId = computed(() => deepLinkInfoLocal.value?.shareId || null);
const deepLinkChatId = computed(() => deepLinkInfoLocal.value?.chatId || null);
const canAccessMyStuff = computed(() => !isDeepLink.value && !props.user?.isDeepLink);
const restoreApplied = ref(false);

const applyRestoredChatState = (state: NonNullable<Props['restoreChatState']>) => {
  if (restoreApplied.value) return;
  if (!state) return;
  messages.value = Array.isArray(state.messages) ? state.messages : [];
  uploadedFiles.value = Array.isArray(state.uploadedFiles) ? state.uploadedFiles : [];
  inputMessage.value = state.inputMessage || '';
  currentSavedChatId.value = state.savedChatId || null;
  currentSavedChatShareId.value = state.savedChatShareId || null;

  const providerLabel = state.providerLabel || getProviderLabelFromKey(state.providerKey || '');
  if (providerLabel) {
    selectedProvider.value = providerLabel;
  }

  originalMessages.value = JSON.parse(JSON.stringify(messages.value));
  trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
  restoreApplied.value = true;
  emit('restore-applied');
};

watch(
  () => props.restoreChatState,
  (state) => {
    if (state) {
      applyRestoredChatState(state);
    }
  }
);

watch(
  () => props.rehydrationActive,
  (active) => {
    if (active) {
      wizardDismissed.value = false;
      if (!showAgentSetupDialog.value) {
        showAgentSetupDialog.value = true;
      }
    }
  },
  { immediate: true }
);

watch(
  () => (Array.isArray(props.rehydrationFiles) ? props.rehydrationFiles.length : 0),
  (count) => {
    if (count > 0) {
      wizardDismissed.value = false;
      if (!showAgentSetupDialog.value) {
        showAgentSetupDialog.value = true;
      }
    }
  },
  { immediate: true }
);

watch(
  () => props.suppressWizard,
  async (suppressed, wasSuppressed) => {
    if (suppressed) {
      showAgentSetupDialog.value = false;
      return;
    }
    if (wasSuppressed && !suppressed) {
      wizardDismissed.value = false;
      wizardSlideIndex.value = 0;
      await refreshWizardState();
      if (!shouldHideSetupWizard.value && !showAgentSetupDialog.value && !wizardDismissed.value) {
        showAgentSetupDialog.value = true;
      }
    }
  },
  { immediate: true }
);
watch(
  () => showAgentSetupDialog.value,
  (isOpen, wasOpen) => {
    if (isOpen) {
      // Only log a NEW "Setup started" the first time the wizard opens
      // for this user this session. Re-opens (e.g. the agent-status
      // poll re-showing it, or returning from My Stuff) are the SAME
      // continuous setup — logging again fragmented maia-log.pdf into
      // duplicate "--- Setup ---" sections.
      if (setupStartedLoggedForUser.value !== (props.user?.userId || '')) {
        setupStartedLoggedForUser.value = props.user?.userId || '';
        logProvisioningEvent({
          event: 'setup-started',
          test: testMode.value || undefined,
          method: 'setup',
          client: {
            browser: parseUserAgent(),
            appUrl: window.location.origin,
            folder: localFolderName.value || 'unknown',
            version: packageJson.version
          }
        });
      }
      wizardSlideIndex.value = 0;
      void loadWizardMessages();
      void positionWizardInlineDots();
      if (agentSetupPollingActive.value) {
        const key = wizardAgentSetupStartedKey(props.user?.userId);
        try {
          const stored = key ? sessionStorage.getItem(key) : null;
          if (stored) {
            const startedAt = parseInt(stored, 10);
            const maxAgeMs = 20 * 60 * 1000;
            if (!isNaN(startedAt) && (Date.now() - startedAt) < maxAgeMs) {
              agentSetupElapsed.value = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            }
          }
        } catch { /* ignore */ }
        stopAgentSetupTimer();
        agentSetupTimer = setInterval(() => {
          agentSetupElapsed.value += 1;
        }, 1000);
      }
    } else if (wasOpen) {
      nextTick(() => void checkAndShowNeedsIndexingPrompt());
    }
  }
);
watch(
  () => [wizardIntroBodyHtml.value, wizardSlideIndex.value],
  () => {
    void positionWizardInlineDots();
  }
);

// Deferred-indexing watcher removed — indexing now starts immediately in runAutoWizard.
// wizardPatientSummary auto-dismiss watcher removed — guided flow handles this via wizardFlowPhase.

const startRestoreIndexing = async () => {
  if (!props.user?.userId) {
    restoreIndexingQueued.value = false;
    return;
  }
  try {
    const filesResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(props.user.userId)}`, {
      credentials: 'include'
    });
    if (!filesResponse.ok) {
      restoreIndexingQueued.value = false;
      return;
    }
    const filesResult = await filesResponse.json();

    // Idempotency guard: if the KB already covers every file the
    // server lists, skip the re-index. Without this, every
    // sign-in after a successful Restore re-POSTs
    // /api/update-knowledge-base, which spawns a fresh DO indexing
    // job that the My Stuff modelValue watcher then surfaces as an
    // "Indexing in progress" badge / modal on the user's next open
    // — confusing because the user didn't trigger anything.
    const indexingState = filesResult?.indexingState;
    if (indexingState?.allKbFilesIndexed === true) {
      restoreIndexingQueued.value = false;
      return;
    }
    // Also skip if a DO indexing job is ALREADY running for this
    // user (don't pile a duplicate on top — the existing job will
    // finish and cover any unindexed files).
    const kbIndexing = filesResult?.kbIndexingStatus;
    const indexingInProgress = !!(
      kbIndexing &&
      kbIndexing.backendCompleted !== true &&
      (kbIndexing.phase === 'indexing' || kbIndexing.phase === 'indexing_started')
    );
    if (indexingInProgress) {
      restoreIndexingQueued.value = false;
      return;
    }

    const files = Array.isArray(filesResult?.files)
      ? (filesResult.files as Array<{ fileName?: string; bucketKey?: string }>)
      : [];
    const names = files
      .map(file => getFileNameFromEntry(file))
      .filter((name): name is string => !!name);
    const uniqueNames = Array.from(new Set(names));
    if (uniqueNames.length === 0) {
      restoreIndexingQueued.value = false;
      return;
    }
    wizardStage3Files.value = uniqueNames.map(name => ({ name }));
    await handleStage3Index(uniqueNames, true);
  } finally {
    restoreIndexingQueued.value = false;
  }
};

/**
 * Saved Files is the source of truth. Show "Index your records" only when Saved Files would show
 * at least one file "To be added and indexed" (i.e. !allKbFilesIndexed from /api/user-files indexingState).
 * Dismissed with NOT YET stays until reload.
 */
const checkAndShowNeedsIndexingPrompt = async () => {
  if (!props.user?.userId || props.rehydrationActive || props.restoreActive || isDeepLink.value || needsIndexingPromptDismissedThisSession.value) return;
  try {
    const [filesRes, statusRes] = await Promise.all([
      fetch(`/api/user-files?userId=${encodeURIComponent(props.user.userId)}`, { credentials: 'include' }),
      fetch(`/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, { credentials: 'include' })
    ]);
    if (!filesRes.ok || !statusRes.ok) return;
    const filesData = await filesRes.json();
    const statusData = await statusRes.json();
    const indexingState = filesData?.indexingState;
    const allKbFilesIndexed = !!indexingState?.allKbFilesIndexed;
    if (allKbFilesIndexed) return;
    const kbIndexing = filesData?.kbIndexingStatus;
    const indexingInProgress = !!(
      kbIndexing &&
      kbIndexing.backendCompleted !== true &&
      (kbIndexing.phase === 'indexing' || kbIndexing.phase === 'indexing_started')
    );
    if (indexingInProgress) return;
    const hasAgent = !!statusData?.hasAgent;
    const fileCount = Number(statusData?.fileCount) || 0;
    const kbStatus = statusData?.kbStatus || 'none';
    const needsIndexing =
      hasAgent &&
      fileCount > 0 &&
      (kbStatus === 'none' || kbStatus === 'not_attached' || !statusData?.hasFilesInKB);
    if (needsIndexing) {
      showNeedsIndexingPrompt.value = true;
    }
  } catch {
    // ignore
  }
};

/** INDEX NOW from needs-indexing prompt: open wizard and start indexing. */
const handleNeedsIndexingIndexNow = async () => {
  showNeedsIndexingPrompt.value = false;
  wizardDismissed.value = false;
  showAgentSetupDialog.value = true;
  await nextTick();
  await startRestoreIndexing();
};

const handleRehydrationComplete = async (payload: { hasInitialFile: boolean }) => {
  emit('rehydration-complete', payload);
  let shouldAutoProcess = !!payload?.hasInitialFile;
  let hasCurrentMedications = false;
  // Always check user-status so we can suppress auto-open when medications are already saved,
  // regardless of whether the rehydration payload already indicated an initial file.
  if (props.user?.userId) {
    try {
      const statusResponse = await fetch(`/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, {
        credentials: 'include'
      });
      if (statusResponse.ok) {
        const statusResult = await statusResponse.json();
        if (!shouldAutoProcess) {
          shouldAutoProcess = !!statusResult?.initialFile;
        }
        hasCurrentMedications = !!statusResult?.currentMedications;
      }
    } catch (error) {
      // ignore status fetch errors
    }
  }
  if (hasCurrentMedications) {
    shouldAutoProcess = false;
  }
  if (shouldAutoProcess) {
    try {
      sessionStorage.setItem('autoProcessInitialFile', 'true');
      sessionStorage.setItem('wizardMyListsAuto', 'true');
    } catch (error) {
      // ignore storage errors
    }
    myStuffInitialTab.value = 'lists';
    showMyStuffDialog.value = true;
  }
  await refreshWizardState();
  if (!shouldHideSetupWizard.value && !showAgentSetupDialog.value && !wizardDismissed.value) {
    showAgentSetupDialog.value = true;
  }
  if (!restoreIndexingQueued.value) {
    restoreIndexingQueued.value = true;
    await startRestoreIndexing();
  }
};

type UploadedFilePayload = {
  id: string;
  name: string;
  size: number;
  type: string;
  bucketKey?: string;
  bucketPath?: string;
  uploadedAt?: string | Date;
};

const buildUploadedFilePayload = (): UploadedFilePayload[] =>
  uploadedFiles.value.map(file => ({
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    bucketKey: file.bucketKey,
    bucketPath: file.bucketPath,
    uploadedAt: file.uploadedAt instanceof Date ? file.uploadedAt.toISOString() : file.uploadedAt
  }));

const buildChatHistoryPayload = () => JSON.parse(JSON.stringify(messages.value));

const getComparableChatState = () => ({
  messages: messages.value.map(msg => ({
    role: msg.role,
    content: msg.content,
    authorId: msg.authorId,
    authorLabel: msg.authorLabel,
    authorType: msg.authorType,
    providerKey: msg.providerKey
  })),
  files: uploadedFiles.value.map(file => ({
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    bucketKey: file.bucketKey,
    bucketPath: file.bucketPath
  }))
});

const currentChatSnapshot = computed(() => JSON.stringify(getComparableChatState()));

const canSaveLocally = computed(() => currentChatSnapshot.value !== lastLocalSaveSnapshot.value);
const canSaveToGroup = computed(() => currentChatSnapshot.value !== lastGroupSaveSnapshot.value);

const userResourceStatus = ref<{
  hasAgent: boolean;
  kbStatus: string;
  hasKB: boolean;
  hasFilesInKB: boolean;
  workflowStage?: string | null;
  // Drives the Setup Wizard rail icon's yellow spinner. Set in
  // refreshWizardState() from /api/user-files (kbIndexingActive)
  // and /api/patient-summary (hasPatientSummary). Other setters
  // (e.g. updateContextualTip, which only calls /api/user-status)
  // PRESERVE these two from the prior value rather than zeroing
  // them — otherwise the spinner flickers between refreshes.
  kbIndexingActive?: boolean;
  hasPatientSummary?: boolean;
  // True when the server has a saved currentMedications text. The
  // only way that field becomes non-empty is via the Lists tab's
  // "Verify" or "Save edit" buttons — both POST through
  // /api/user-current-medications with the user-confirmed value.
  // So `hasCurrentMedications === true` ≡ "user has verified
  // current medications". Drives the My Lists rail icon outline
  // and the "must verify meds first" gate on Patient Summary.
  hasCurrentMedications?: boolean;
} | null>(null);

// "Wizard is incomplete" indicator for the rail spinner. Reflects
// real outstanding setup work, not just session-local state. Order:
//   1. Wizard dialog is currently open / focused.
//   2. wizardFlowPhase is non-'done' (a multi-step flow is mid-way).
//   3. Status hasn't loaded yet — don't claim incompleteness.
//   4. KB is actively indexing right now.
//   5. workflowStage hasn't reached 'link_stored' (the final stage).
//   6. Agent is provisioned but there's still no Patient Summary
//      (final user-facing setup gate).
// Stages that count as "wizard done" — the user can still do more
// (share a chat, save more files) but the initial setup is complete.
// Anything BEFORE these means setup work is still outstanding.
// - 'patient_summary': user has generated + verified a Patient
//   Summary. This is the last user-facing setup gate.
// - 'link_stored':    user has additionally saved/shared a chat
//   link. Bonus stage, not required for "wizard done."
const WIZARD_DONE_STAGES = new Set(['patient_summary', 'link_stored']);

const wizardActive = computed<boolean>(() => {
  if (wizardPatientSummary.value) return false;
  if (showAgentSetupDialog.value) return true;
  if (wizardFlowPhase.value !== 'done') return true;
  const status = userResourceStatus.value;
  if (!status) return false;
  if (status.kbIndexingActive === true) return true;
  if (status.workflowStage && !WIZARD_DONE_STAGES.has(status.workflowStage)) return true;
  if (status.hasAgent && status.hasPatientSummary === false) return true;
  return false;
});

// Current Medications need verification when the server has no
// saved currentMedications (the only way that field becomes
// non-empty is via the user's Verify / Save-edit action in the
// Lists tab, both of which POST through /api/user-current-
// medications). Drives the yellow outline on the My Lists rail
// icon AND the "must verify meds first" gate when the user tries
// to navigate to Patient Summary. Treats `undefined` as
// "haven't loaded yet — don't false-alarm".
const medsNeedsVerify = computed<boolean>(() => {
  if (wizardPatientSummary.value) return false;
  const status = userResourceStatus.value;
  if (!status) return false;
  if (!status.hasAgent) return false;
  return status.hasCurrentMedications === false;
});
const isRequestSent = computed(() => userResourceStatus.value?.workflowStage === 'request_sent');
const statusPollInterval = ref<ReturnType<typeof setInterval> | null>(null);
const showRequestSentModal = ref(false);
const requestSentModalShown = ref(false); // Track if modal has been shown to avoid showing it repeatedly

watch(
  () => props.user?.userId,
  () => {
    currentSavedChatId.value = null;
    currentSavedChatShareId.value = null;
    lastLocalSaveSnapshot.value = currentChatSnapshot.value;
    lastGroupSaveSnapshot.value = currentChatSnapshot.value;
  }
);

watch(
  [isDeepLink, deepLinkShareId, deepLinkChatId],
  ([, shareId, chatId], [, prevShareId, prevChatId]) => {
    if (!canAccessMyStuff.value) {
      showMyStuffDialog.value = false;
    }

    if (shareId && (shareId !== prevShareId || chatId !== prevChatId)) {
      hasLoadedDeepLinkChat.value = false;
    }

    if (chatId && currentSavedChatId.value !== chatId) {
      currentSavedChatId.value = chatId;
    }
    if (shareId && currentSavedChatShareId.value !== shareId) {
      currentSavedChatShareId.value = shareId;
    }

    if (shareId) {
      loadDeepLinkChat();
    }
  },
  { immediate: true }
);

watch(
  () => [messages.value.length, uploadedFiles.value.length],
  ([messageCount, fileCount]) => {
    if (messageCount === 0 && fileCount === 0) {
      currentSavedChatId.value = null;
      currentSavedChatShareId.value = null;
      lastLocalSaveSnapshot.value = currentChatSnapshot.value;
      lastGroupSaveSnapshot.value = currentChatSnapshot.value;
    }
  }
);

// Reset initial page when PDF viewer closes
watch(() => showPdfViewer.value, (isOpen) => {
  if (!isOpen) {
    pdfInitialPage.value = undefined;
  }
});

// Raw model name for each provider key — populated from providerModels API response
const providerModelNames: Record<string, string> = {};

// Provider labels map — updated dynamically from providerModels API response
const providerLabels: Record<string, string> = {
  digitalocean: 'Private AI',
  anthropic: 'Anthropic',
  openai: 'ChatGPT',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  'deepseek-r1': 'DeepSeek R1'
};

const modelDisplayNames: Record<string, string> = {
  'anthropic-claude-4.6-sonnet': 'Claude Sonnet 4.6',
  'anthropic-claude-5-sonnet': 'Claude Sonnet 5',
  'openai-gpt-4o': 'GPT-4o',
  'openai-gpt-5.5': 'GPT-5.5',
  'openai-gpt-oss-120b': 'GPT OSS 120B',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-r1-distill-llama-70b': 'DeepSeek R1 70B',
  'nvidia-nemotron-3-super-120b': 'Nemotron 120B',
  'kimi-k2.5': 'Kimi K2.5',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
};

// Private AI profiles reported by /api/chat/providers. Each ready
// profile (e.g. Deepseek, GPT) becomes its own dropdown entry; the
// chat request carries the profile key so the server picks the agent.
const privateAiProfiles = ref<Array<{ key: string; label: string; model?: string }>>([]);

// Canonical default Private AI dropdown label (first ready profile =
// Deepseek; falls back to the generic label for legacy single-agent).
const defaultPrivateAiLabel = () =>
  privateAiProfiles.value[0]?.label || providerLabels.digitalocean;

// Computed provider options for dropdown. `digitalocean` expands to one
// entry per ready Private AI profile.
const providerOptions = computed(() => {
  const opts: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  const privateAiModels = new Set(privateAiProfiles.value.map(pr => pr.model).filter(Boolean));
  for (const p of providers.value) {
    if (p === 'digitalocean') {
      if (privateAiProfiles.value.length > 0) {
        for (const prof of privateAiProfiles.value) {
          opts.push({ label: prof.label, value: prof.label });
          seen.add(prof.label);
        }
      } else {
        opts.push({ label: providerLabels.digitalocean, value: providerLabels.digitalocean });
        seen.add(providerLabels.digitalocean);
      }
    } else {
      if (providerModelNames[p] && privateAiModels.has(providerModelNames[p])) continue;
      const label = providerLabels[p] || p.charAt(0).toUpperCase() + p.slice(1);
      if (seen.has(label)) continue;
      opts.push({ label, value: label });
      seen.add(label);
    }
  }
  return opts;
});

// Re-derive each Private AI label from the actual model name and sort
// Kimi first, GPT second. We do this client-side (it also happens
// server-side) so the dropdown stays correctly ordered even if the
// server response is cached/stale. The 'default' / 'gpt' profile keys
// are HISTORICAL slot names. Pure function — call it on the array we
// just got from the server.
const normalizePrivateAiProfiles = (
  raw: Array<{ key: string; label: string; model?: string }>
): Array<{ key: string; label: string; model?: string }> => {
  const modelShort = (m?: string) => {
    const s = String(m || '').toLowerCase();
    if (s.includes('kimi')) return 'Kimi';
    if (s.includes('gpt')) return 'GPT';
    if (s.includes('deepseek')) return 'Deepseek';
    return '';
  };
  return [...raw]
    .map(pr => {
      const role = pr.key === 'default' ? 'Primary' : 'Secondary';
      const model = modelShort(pr.model);
      const label = model ? `Private AI ${role} (${model})` : `Private AI (${role.toLowerCase()})`;
      return { ...pr, label };
    })
    // Primary first
    .sort((a, b) => (a.key === 'default' ? 0 : 1) - (b.key === 'default' ? 0 : 1));
};

// True when the given label is any Private AI variant.
const isPrivateAiLabel = (label: string) =>
  label === providerLabels.digitalocean ||
  label.startsWith('Private AI') ||
  privateAiProfiles.value.some(pr => pr.label === label);

// Dynamic label for a profile key ('default' = primary, 'gpt' = secondary).
// normalizePrivateAiProfiles already formats as "Private AI Primary (GPT)" etc.
const labelForProfileKey = (key: string): string => {
  const prof = privateAiProfiles.value.find(p => p.key === key);
  if (prof) return prof.label;
  if (key === 'default') return 'Private AI Primary (GPT)';
  return 'Private AI Secondary (Kimi)';
};

// The agentProfileKey for the current selection (null for non-Private
// AI). Defaults to 'default' for a Private AI label with no match
// (legacy single-agent docs).
const selectedAgentProfileKey = computed(() => {
  const label = normalizeProviderLabel(selectedProvider.value);
  if (!isPrivateAiLabel(label)) return null;
  const match = privateAiProfiles.value.find(pr => pr.label === label);
  return match?.key || 'default';
});

// Helper to get provider key from label
const normalizeProviderLabel = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const candidate = (value as { label?: unknown; value?: unknown }).label
      ?? (value as { value?: unknown }).value;
    if (typeof candidate === 'string') return candidate;
  }
  return '';
};

const getProviderKey = (label: unknown) => {
  const normalized = normalizeProviderLabel(label);
  // Any "Private AI (…)" variant maps to the digitalocean provider;
  // the specific agent is chosen via agentProfileKey.
  if (normalized === providerLabels.digitalocean ||
      normalized.startsWith('Private AI') ||
      privateAiProfiles.value.some(pr => pr.label === normalized)) {
    return 'digitalocean';
  }
  const entry = Object.entries(providerLabels).find(([_, l]) => l === normalized);
  return entry ? entry[0] : normalized.toLowerCase();
};

const isPrivateAISelected = computed(() => getProviderKey(selectedProvider.value) === 'digitalocean');
const PRIVATE_AI_DEFAULT_PROMPT = 'Click SEND to get the patient summary';

// Detect a "list all / show all / history / trend / over time / timeline"
// request for a specific lab analyte. When matched, the chat handler
// routes through /api/labs/history (deterministic, complete) instead
// of raw RAG (top-k bounded, incomplete). Kept in sync with the
// server's ANALYTE_SYNONYMS table (server/utils/lab-history.js) — the
// regex is intentionally generous; the server is the authoritative
// matcher. Returns `null` when no intent is detected.
const LAB_INTENT_VERBS = /\b(list|show|all|history|trend|trends|timeline|over time|chronolog|sort(ed)? by date)\b/i;
const LAB_ANALYTE_TERMS: Array<{ display: string; term: string; pattern: RegExp }> = [
  { display: 'TSH', term: 'tsh', pattern: /\b(tsh|thyroid[- ]stimulat\w*|thyrotropin)\b/i },
  { display: 'Free T4', term: 'free t4', pattern: /\b(free\s*t4|ft4|thyroxine)\b/i },
  { display: 'Free T3', term: 'free t3', pattern: /\b(free\s*t3|ft3)\b/i },
  { display: 'Hemoglobin A1c', term: 'a1c', pattern: /\b(hb?a1c|hemoglobin\s+a1c|glycated\s+hemoglobin|glycohemoglobin)\b/i },
  { display: 'Glucose', term: 'glucose', pattern: /\b(glucose|fasting\s+glucose|blood\s+sugar)\b/i },
  { display: 'LDL', term: 'ldl', pattern: /\b(ldl([- ]c)?|low[- ]density\s+lipoprotein)\b/i },
  { display: 'HDL', term: 'hdl', pattern: /\b(hdl([- ]c)?|high[- ]density\s+lipoprotein)\b/i },
  { display: 'Triglycerides', term: 'triglycerides', pattern: /\b(triglycerid\w*|trig|tg)\b/i },
  { display: 'Total Cholesterol', term: 'cholesterol', pattern: /\b(total\s+cholesterol|cholesterol\s+total|cholesterol)\b/i },
  { display: 'Creatinine', term: 'creatinine', pattern: /\b(creatinine|creat\b|serum\s+creatinine)\b/i },
  { display: 'BUN', term: 'bun', pattern: /\b(bun|blood\s+urea\s+nitrogen|urea\s+nitrogen)\b/i },
  { display: 'eGFR', term: 'egfr', pattern: /\b(egfr|estimated\s+gfr|glomerular\s+filtration)\b/i },
  { display: 'Potassium', term: 'potassium', pattern: /\b(potassium|k\+)\b/i },
  { display: 'Sodium', term: 'sodium', pattern: /\b(sodium|na\+)\b/i },
  { display: 'Hemoglobin', term: 'hemoglobin', pattern: /\b(hemoglobin|hgb|hb)\b/i },
  { display: 'Hematocrit', term: 'hematocrit', pattern: /\b(hematocrit|hct)\b/i },
  { display: 'WBC', term: 'wbc', pattern: /\b(wbc|white\s+blood\s+cell|leukocyte)\b/i },
  { display: 'Platelet', term: 'platelet', pattern: /\b(platelet|plt)\b/i },
  { display: 'ALT', term: 'alt', pattern: /\b(alt|sgpt|alanine)\b/i },
  { display: 'AST', term: 'ast', pattern: /\b(ast|sgot|aspartate)\b/i },
  { display: 'PSA', term: 'psa', pattern: /\b(psa|prostate[- ]specific\s+antigen)\b/i },
  { display: 'Vitamin D', term: 'vitamin d', pattern: /\b(vitamin\s+d|25[- ]oh|25[- ]hydroxy)\b/i },
  { display: 'Vitamin B12', term: 'b12', pattern: /\b(b12|cyanocobalamin)\b/i },
  { display: 'CRP', term: 'crp', pattern: /\b(crp|c[- ]reactive\s+protein)\b/i }
];
const parseLabHistoryIntent = (text: string): { displayName: string; analyteTerm: string } | null => {
  const s = String(text || '');
  if (!s.trim()) return null;
  if (!LAB_INTENT_VERBS.test(s)) return null;
  // First analyte that matches wins. Single-analyte intent only (a
  // request like "show all TSH and A1c" would only get TSH; the user
  // can ask again for A1c).
  for (const a of LAB_ANALYTE_TERMS) {
    if (a.pattern.test(s)) return { displayName: a.display, analyteTerm: a.term };
  }
  return null;
};

// Detect "show me a link to the <last|most recent|<date>> <encounter|
// visit|note|appointment>" and similar phrasings. Returns the `ref`
// to pass to /api/encounters/find. Returns null when no encounter
// intent is detected.
//
// Recognized verbs: show / show me / link to / link / open / find /
// where (is) / what was (the).
// Recognized nouns: encounter / visit / note / appointment / clinical
// note / progress note / consultation.
// Recognized refs: latest / last / most recent (→ "latest"), an
// explicit YYYY-MM-DD or M/D/YYYY date, or a freeform fragment
// matched against the encounter descriptor / type.
const ENCOUNTER_VERB = /\b(show|link|open|find|where|locate|give\s+me|get\s+me|tell\s+me\s+about|describe|summari[sz]e)\b/i;
const ENCOUNTER_NOUN = /\b(encounter|visit|note|notes|appointment|consultation|consult)\b/i;
// Interrogative phrasings — "what was the most recent encounter?",
// "when was my last visit?", "which was my latest appointment?". These
// also count as intent IF they include a temporal anchor (recency or
// explicit date), so we don't fire on generic questions like "what is
// an encounter?".
const ENCOUNTER_INTERROG = /\b(what|which|when|how)\b/i;
const ENCOUNTER_RECENCY = /\b(latest|last|most[\s-]?recent|newest|next|upcoming|first|earliest|oldest)\b/i;
const ENCOUNTER_DATE_HINT = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i;
const parseEncounterLinkIntent = (text: string): { ref: string; displayHint: string } | null => {
  const s = String(text || '');
  if (!s.trim()) return null;
  if (!ENCOUNTER_NOUN.test(s)) return null;
  const hasVerb = ENCOUNTER_VERB.test(s);
  const hasInterrog = ENCOUNTER_INTERROG.test(s);
  const hasAnchor = ENCOUNTER_RECENCY.test(s) || ENCOUNTER_DATE_HINT.test(s);
  // Path A: imperative verb + noun (existing behavior).
  // Path B: interrogative + noun + temporal anchor (new). The anchor
  // requirement keeps generic "what is an encounter?" / "what does a
  // note look like?" from being hijacked.
  if (!hasVerb && !(hasInterrog && hasAnchor)) return null;
  // Explicit ISO date wins.
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return { ref: `${iso[1]}-${iso[2]}-${iso[3]}`, displayHint: `on ${iso[0]}` };
  // US-style M/D/YYYY date.
  const us = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (us) {
    const ref = `${us[3]}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
    return { ref, displayHint: `on ${ref}` };
  }
  // Spelled-month date ("May 7 2026" / "May 7, 2026").
  const months: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
    october: 10, nov: 11, november: 11, dec: 12, december: 12
  };
  const spelled = s.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (spelled) {
    const m = months[spelled[1].slice(0, 3).toLowerCase()];
    if (m) {
      const ref = `${spelled[3]}-${String(m).padStart(2, '0')}-${String(spelled[2]).padStart(2, '0')}`;
      return { ref, displayHint: `on ${ref}` };
    }
  }
  // "latest / last / most recent" — the most common phrasing.
  if (/\b(latest|last|most[\s-]?recent|newest)\b/i.test(s)) {
    return { ref: 'latest', displayHint: 'most recent' };
  }
  // Type hint ("telemedicine", "inpatient", "admission").
  const typeMatch = s.match(/\b(telemedicine|telehealth|video|phone|telephone|inpatient|admission|emergency|outpatient|office|procedure|imaging)\b/i);
  if (typeMatch) return { ref: typeMatch[1], displayHint: `matching "${typeMatch[1]}"` };
  // No more-specific anchor — default to most recent.
  return { ref: 'latest', displayHint: 'most recent' };
};

const selectFirstNonPrivateProvider = () => {
  const fallback = providers.value.find(p => p !== 'digitalocean');
  if (fallback) {
    selectedProvider.value = providerLabels[fallback] || fallback;
  }
};

const logWizardEvent = async (event: string, details?: Record<string, unknown>) => {
  try {
    await fetch('/api/wizard-log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        event,
        userId: props.user?.userId,
        details: details || {}
      })
    });
  } catch (error) {
    // Ignore logging errors
  }
};

// Clear preset prompt when user clicks into the input
function clearPresetPrompt() {
  if (inputMessage.value === PRIVATE_AI_DEFAULT_PROMPT) {
    inputMessage.value = '';
  }
}

// Helper functions for labels
const getUserLabel = () => {
  return props.user?.userId || 'You';
};

const getProviderLabelFromKey = (providerKey: string | undefined) => {
  if (!providerKey) return 'Assistant';
  return providerLabels[providerKey] || providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
};

// Label an assistant message with the SPECIFIC AI that produced it. For
// Private AI this is the selected profile label (e.g. "Private AI
// (Deepseek)" vs "Private AI (GPT)") so the transcript shows which
// agent answered, not a generic "Private AI".
const assistantLabelForKey = (providerKey: string | undefined) => {
  if (providerKey === 'digitalocean') {
    const lbl = normalizeProviderLabel(selectedProvider.value);
    return isPrivateAiLabel(lbl) ? lbl : providerLabels.digitalocean;
  }
  return getProviderLabelFromKey(providerKey);
};

const getProviderLabel = () => {
  const normalized = normalizeProviderLabel(selectedProvider.value);
  return providerLabels[normalized] || normalized;
};

const getMessageLabel = (msg: Message) => {
  if (msg.authorLabel) return msg.authorLabel;
  if (msg.name) return msg.name;
  if (msg.authorType === 'assistant') {
    return getProviderLabelFromKey(msg.providerKey);
  }
  if (msg.authorId) return msg.authorId;
  return getUserLabel();
};

const normalizeMessage = (msg: Message): Message => {
  const authorType = msg.authorType || (msg.role === 'assistant' ? 'assistant' : 'user');
  const providerKey = msg.providerKey || (authorType === 'assistant' ? getProviderKey(msg.authorLabel || msg.name || selectedProvider.value) : undefined);
  const authorLabel = msg.authorLabel || msg.name || (authorType === 'assistant' ? getProviderLabelFromKey(providerKey) : msg.authorId || getUserLabel());
  const authorId = msg.authorId || (authorType === 'assistant' ? providerKey : (msg.authorLabel === getUserLabel() ? getUserLabel() : props.user?.userId));

  return {
    ...msg,
    authorType,
    providerKey,
    authorLabel,
    authorId,
    name: authorLabel
  };
};

// Load owner's deep link Private AI access setting
const loadOwnerDeepLinkSetting = async () => {
  if (!isDeepLink.value) {
    // For regular users, load their own setting
    if (!props.user?.userId) return;
    try {
      const response = await fetch(`/api/user-settings?userId=${encodeURIComponent(props.user.userId)}`, {
        credentials: 'include'
      });
      if (response.ok) {
        const result = await response.json();
        ownerAllowDeepLinkPrivateAI.value = result.allowDeepLinkPrivateAI !== undefined ? result.allowDeepLinkPrivateAI : true;
      } else {
        ownerAllowDeepLinkPrivateAI.value = true; // Default to enabled
      }
    } catch (error) {
      console.warn('Failed to load deep link setting, defaulting to enabled:', error);
      ownerAllowDeepLinkPrivateAI.value = true;
    }
  } else {
    // For deep link users, leave ownerAllowDeepLinkPrivateAI as null until we load the chat
    // and fetch the owner's setting in handleChatSelected. Do not default to false here,
    // or we would filter out Private AI and show "Private AI Unavailable" before we know
    // the owner's preference.
  }
};

// Fetch available providers
const loadProviders = async () => {
  try {
    const response = await fetch('/api/chat/providers');
    const data = await response.json();
    let availableProviders = data.providers;
    
    // Filter out Private AI for deep link users if owner disabled it
    if (isDeepLink.value && ownerAllowDeepLinkPrivateAI.value === false) {
      availableProviders = availableProviders.filter((p: string) => p !== 'digitalocean');
    }
    
    providers.value = availableProviders;

    if (data.providerModels) {
      for (const [key, model] of Object.entries(data.providerModels)) {
        if (model) {
          providerModelNames[key] = model as string;
          if (modelDisplayNames[model as string]) {
            providerLabels[key] = modelDisplayNames[model as string];
          }
        }
      }
    }

    privateAiProfiles.value = normalizePrivateAiProfiles(
      Array.isArray(data.privateAiProfiles) ? data.privateAiProfiles : []
    );

    // Keep wizard model name refs in sync whenever profiles are loaded
    if (privateAiProfiles.value.length > 0) {
      wizardPrimaryModelName.value = labelForProfileKey('default');
    }
    // Sync secondary agent ready state from profiles
    if (privateAiProfiles.value.some(p => p.key === 'gpt')) {
      gptAgentReady.value = true;
    }

    if (providers.value.length > 0) {
      if (providers.value.includes('digitalocean')) {
        // Only reset the dropdown if the current selection isn't already
        // a valid Private AI label — otherwise a mid-session providers
        // reload (e.g. from refreshWizardState) would clobber the user's
        // secondary AI selection back to the primary.
        const currentLabel = normalizeProviderLabel(selectedProvider.value);
        const isSpecificProfile = privateAiProfiles.value.some(pr => pr.label === currentLabel);
        if (!isSpecificProfile) {
          selectedProvider.value = privateAiProfiles.value[0]?.label || providerLabels.digitalocean;
        }
        showPrivateUnavailableDialog.value = false; // clear in case it was shown before refetch
      } else {
        if (initialLoadComplete.value && !showAgentSetupDialog.value && !props.restoreActive) {
          showPrivateUnavailableDialog.value = true;
        }
        selectFirstNonPrivateProvider();
      }
    }
  } catch (error) {
    console.error('Failed to load providers:', error);
    // Fallback for development
    let fallbackProviders = ['digitalocean', 'anthropic'];
    if (isDeepLink.value && ownerAllowDeepLinkPrivateAI.value === false) {
      fallbackProviders = fallbackProviders.filter(p => p !== 'digitalocean');
    }
    providers.value = fallbackProviders;
    if (providers.value.includes('digitalocean')) {
      selectedProvider.value = defaultPrivateAiLabel();
      showPrivateUnavailableDialog.value = false;
    } else {
      if (initialLoadComplete.value && !showAgentSetupDialog.value && !props.restoreActive) {
        showPrivateUnavailableDialog.value = true;
      }
      selectFirstNonPrivateProvider();
    }
  }
};

watch(
  [isPrivateAISelected, () => messages.value.length, () => userResourceStatus.value?.hasAgent],
  ([isPrivate, messageCount, hasAgentRaw]) => {
    const hasAgent = Boolean(hasAgentRaw);
    const shouldPrefill = isPrivate && messageCount === 0 && hasAgent;

    if (shouldPrefill && !inputMessage.value) {
      inputMessage.value = PRIVATE_AI_DEFAULT_PROMPT;
    } else if (!shouldPrefill && inputMessage.value === PRIVATE_AI_DEFAULT_PROMPT) {
      inputMessage.value = '';
    }
  },
  { immediate: true }
);

watch(
  () => providers.value,
  (available) => {
    if (!available.length) return;
    if (available.includes('digitalocean')) {
      // Only reset if the current selection isn't a specific profile
      // label — don't clobber a secondary AI selection, but DO replace
      // the bare "Private AI" fallback with the full profile label.
      const currentWatchLabel = normalizeProviderLabel(selectedProvider.value);
      if (!privateAiProfiles.value.some(pr => pr.label === currentWatchLabel)) {
        selectedProvider.value = defaultPrivateAiLabel();
      }
      showPrivateUnavailableDialog.value = false; // Private AI is available
      return;
    }
    if (getProviderKey(selectedProvider.value) === 'digitalocean') {
      if (initialLoadComplete.value && !showAgentSetupDialog.value && !props.restoreActive) {
        showPrivateUnavailableDialog.value = true;
      }
      selectFirstNonPrivateProvider();
    }
  },
  { immediate: true }
);

// When agent becomes ready (e.g. after wizard Stage 1 or indexing), refetch providers so Private AI appears
watch(
  () => userResourceStatus.value?.hasAgent,
  (hasAgent, prevHasAgent) => {
    if (hasAgent && !prevHasAgent) {
      loadProviders();
    }
  }
);

// When restore completes (restoreActive goes false), refetch providers so Private AI appears
watch(
  () => props.restoreActive,
  (active, wasActive) => {
    if (!active && wasActive) {
      // Restore just completed — reset to bare "Private AI" so loadProviders
      // selects the Primary profile instead of preserving a stale secondary
      // selection from a mid-restore loadProviders call.
      selectedProvider.value = providerLabels.digitalocean;
      loadProviders();
    }
  }
);

// Send message (streaming)
const sendMessage = async () => {
  if (!inputMessage.value || isStreaming.value || isRequestSent.value) return;
  emit('session-dirty');

  const userLabel = getUserLabel();
  const userMessage: Message = {
    role: 'user',
    content: inputMessage.value,
    authorType: 'user',
    authorId: props.user?.userId || userLabel,
    authorLabel: userLabel,
    name: userLabel
  };

  // The stored Patient Summary is returned ONLY when the user pressed
  // SEND without touching the prefilled default prompt. Any typed
  // message (even one that mentions "patient summary") runs a fresh
  // inference on the SELECTED Private AI instead. We still persist the
  // result as the patient summary for an explicit summary request.
  const isUntouchedDefault = inputMessage.value.trim() === PRIVATE_AI_DEFAULT_PROMPT.trim();
  const mentionsSummary = /patient\s+summary/i.test(inputMessage.value);
  const isPatientSummaryRequest = isUntouchedDefault || mentionsSummary;
  // Detect "list all / show all / history / trend / timeline / over time"
  // + a recognizable analyte (TSH, A1c, glucose, LDL, …). When matched,
  // the chat handler routes through /api/labs/history below instead of
  // raw RAG. Captured here, BEFORE inputMessage.value is cleared.
  const labIntent = parseLabHistoryIntent(inputMessage.value);
  // Detect "show me a link to / show me / link to <encounter|visit|note|
  // appointment>" requests. When matched the chat routes through
  // /api/encounters/find so the non-AH source (Epic / MGB / hospital
  // export) is always preferred over the AH summary entry — the rule
  // the Encounters worksheet already follows but plain RAG doesn't.
  const encounterIntent = parseEncounterLinkIntent(inputMessage.value);
  messages.value.push(userMessage);
  originalMessages.value = JSON.parse(JSON.stringify(messages.value)); // Keep original in sync
  // Update trulyOriginalMessages when adding new messages (but not when filtering)
  // This ensures new messages are included in the truly original set
  trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
  inputMessage.value = '';
  // Defer snapshot updates so save buttons stay enabled until the user chooses how to persist the chat
  
  isStreaming.value = true;
  streamingReasoning.value = '';
  reasoningDone.value = false;
  streamingReasoningExpanded.value = false;
  const chatSentAt = Date.now();
  const chatProvider = selectedProvider.value;
  logProvisioningEvent({ event: 'chat-question', provider: chatProvider });

  try {
    // If this is a patient summary request, check for existing summary first
    if (isUntouchedDefault && props.user?.userId) {
      try {
        const summaryResponse = await fetch(`/api/patient-summary?userId=${encodeURIComponent(props.user.userId)}`, {
          credentials: 'include'
        });
        
        if (summaryResponse.ok) {
          const summaryData = await summaryResponse.json();
          if (summaryData.summary && summaryData.summary.trim()) {
            // Use existing summary
            const existingProviderKey = getProviderKey(selectedProvider.value);
            const existingProviderLabel = assistantLabelForKey(existingProviderKey);
            const summaryMessage: Message = {
              role: 'assistant',
              content: summaryData.summary,
              authorType: 'assistant',
              providerKey: existingProviderKey,
              authorId: existingProviderKey,
              authorLabel: existingProviderLabel,
              name: existingProviderLabel
            };
            messages.value.push(summaryMessage);
            // Update originalMessages and trulyOriginalMessages when loading summary from storage
            originalMessages.value = JSON.parse(JSON.stringify(messages.value));
            trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
            isStreaming.value = false;
            return;
          }
        }
      } catch (err) {
        // If fetching summary fails, continue with normal chat flow
        console.warn('Could not fetch existing summary, generating new one:', err);
      }
    }
    // MANUAL "list all <lab>" request to the Private AI:
    // Top-k RAG retrieval is structurally incompatible with "list ALL X"
    // MANUAL "show a link to <encounter|visit|note>" request:
    // Route through /api/encounters/find which reads the persisted
    // structured rows from the Encounters worksheet. Those rows
    // already follow the buildEncountersTable rule of preferring
    // non-Apple-Health sources (Epic / MGB carry the full note,
    // AH is summary-only). Plain RAG can pick whichever chunk
    // happens to rank highest — usually the AH summary — which is
    // exactly the bug this routing closes.
    {
      const providerKeyForEnc = getProviderKey(selectedProvider.value);
      if (encounterIntent && providerKeyForEnc === 'digitalocean' && props.user?.userId) {
        try {
          const url = `/api/encounters/find?ref=${encodeURIComponent(encounterIntent.ref)}`;
          const encRes = await fetch(url, { credentials: 'include' });
          const encJson = await encRes.json().catch(() => ({}));
          if (encRes.ok && encJson.success && encJson.available !== false && encJson.row) {
            const row = encJson.row as {
              isoDate?: string; type?: string; description?: string;
              sources?: Array<{ fileTag?: string; page?: number; isAh?: boolean; fileName?: string | null; bucketKey?: string | null }>;
            };
            const sources = Array.isArray(row.sources) ? row.sources : [];
            // The endpoint already orders sources non-AH first. Emit
            // a citation for each — processPageReferences hyperlinks
            // them. The FIRST one is the primary (non-AH if any).
            const citations = sources
              .filter(s => s.fileName && s.page)
              .map(s => {
                const tag = s.isAh ? ' (Apple Health summary)' : '';
                return `[${s.fileName} p.${s.page}]${tag}`;
              })
              .join('\n');
            const title = `**Encounter — ${encounterIntent.displayHint} (deterministic, from your Encounters worksheet)**`;
            const body = [
              `Date: ${row.isoDate || '(unknown)'}`,
              `Type: ${row.type || '(unknown)'}`,
              row.description ? `${row.description}` : ''
            ].filter(Boolean).join('\n');
            const note = sources.some(s => !s.isAh)
              ? `\n\n_The primary link above is the non-Apple-Health source (carries the full note text). The Apple Health summary link is shown below it if present._`
              : `\n\n_Only an Apple Health summary source is available for this encounter._`;
            const encLabel = assistantLabelForKey(providerKeyForEnc);
            const encMsg: Message = {
              role: 'assistant',
              content: `${title}\n\n${body}\n\n${citations}${note}`,
              authorType: 'assistant',
              providerKey: providerKeyForEnc,
              authorId: providerKeyForEnc,
              authorLabel: encLabel,
              name: encLabel
            };
            messages.value.push(encMsg);
            originalMessages.value = JSON.parse(JSON.stringify(messages.value));
            trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
            isStreaming.value = false;
            return;
          }
          // No worksheet, no match → fall through to RAG silently.
        } catch (err) {
          console.warn('[chat→encounters/find] failed; falling back to raw chat:', err);
        }
      }
    }

    // queries — for a patient with 30 TSH readings, k=15 can never
    // return more than 15, and the two Private AIs each get a DIFFERENT
    // top-15. Sidestep RAG entirely: parse Lists/lab_results.md
    // deterministically via /api/labs/history and render the full time
    // series in chat. Falls back to raw chat (no recognized analyte, no
    // AH sidecar, or any error). Patterned after the patient-summary
    // routing below.
    {
      const providerKeyForLabs = getProviderKey(selectedProvider.value);
      if (labIntent && providerKeyForLabs === 'digitalocean' && props.user?.userId) {
        try {
          const url = `/api/labs/history?analyte=${encodeURIComponent(labIntent.analyteTerm)}`;
          const labRes = await fetch(url, { credentials: 'include' });
          const labJson = await labRes.json().catch(() => ({}));
          // The endpoint returns 200 with `available: false` when the
          // user has no Apple Health sidecar — that's the normal case
          // for accounts without an AH PDF, not an error. Fall through
          // to RAG silently.
          if (
            labRes.ok && labJson.success && labJson.available !== false &&
            Array.isArray(labJson.rows) && labJson.rows.length > 0
          ) {
            type LabRow = { isoDate?: string; value?: string | number; units?: string; flag?: string; page?: number };
            // Per-row citation in [<filename> p.<page>] format so the
            // chat UI's processPageReferences turns each into a
            // clickable link to the AH PDF at that page. Falls back to
            // a bare date/value line when the AH filename isn't known
            // (older accounts where ahFileName wasn't returned).
            const ahFileName: string | null = (typeof labJson.ahFileName === 'string' && labJson.ahFileName) || null;
            const lines = (labJson.rows as LabRow[]).map((r: LabRow) => {
              const flag = r.flag ? ` (${r.flag})` : '';
              const units = r.units ? ` ${r.units}` : '';
              const citation = (ahFileName && r.page) ? ` [${ahFileName} p.${r.page}]` : '';
              return `- ${r.isoDate} — ${r.value}${units}${flag}${citation}`;
            }).join('\n');
            const title = `**${labIntent.displayName} — complete history (deterministic, from your Apple Health export)**`;
            const note = `\n\n_${labJson.total} reading${labJson.total === 1 ? '' : 's'} across ${labJson.entryCount} lab event${labJson.entryCount === 1 ? '' : 's'}; sorted newest first. This list is exhaustive — pulled directly from your AH lab_results sidecar, not RAG._`;
            const labLabel = assistantLabelForKey(providerKeyForLabs);
            const labMsg: Message = {
              role: 'assistant',
              content: `${title}\n\n${lines}${note}`,
              authorType: 'assistant',
              providerKey: providerKeyForLabs,
              authorId: providerKeyForLabs,
              authorLabel: labLabel,
              name: labLabel
            };
            messages.value.push(labMsg);
            originalMessages.value = JSON.parse(JSON.stringify(messages.value));
            trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
            isStreaming.value = false;
            return;
          }
          // 404 (no AH sidecar) or zero rows → fall through to raw RAG chat.
        } catch (err) {
          console.warn('[chat→labs/history] failed; falling back to raw chat:', err);
        }
      }
    }

    // MANUAL "patient summary" request to the Private AI:
    // Re-route through /api/patient-summary/draft so the SAME Layer-2
    // prompt, identity/encounters/allergies/OOR-labs/currentMedications
    // injection, and primary-agent instructions are used. A typed message
    // like "Please regenerate my patient summary" must NOT bypass those
    // by going through raw /api/chat/digitalocean. The result is also
    // saved as the formal Patient Summary (same as the SEND path).
    {
      const providerKeyForCheck = getProviderKey(selectedProvider.value);
      if (mentionsSummary && !isUntouchedDefault && providerKeyForCheck === 'digitalocean' && props.user?.userId) {
        try {
          const draftRes = await fetch('/api/patient-summary/draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ userId: props.user.userId })
          });
          const draftJson = await draftRes.json().catch(() => ({}));
          if (draftRes.ok && draftJson.success && draftJson.summary) {
            const psLabel = assistantLabelForKey(providerKeyForCheck);
            const psMessage: Message = {
              role: 'assistant',
              content: draftJson.summary,
              authorType: 'assistant',
              providerKey: providerKeyForCheck,
              authorId: providerKeyForCheck,
              authorLabel: psLabel,
              name: psLabel
            };
            messages.value.push(psMessage);
            await savePatientSummary(draftJson.summary);
            originalMessages.value = JSON.parse(JSON.stringify(messages.value));
            trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
            isStreaming.value = false;
            showNewSummaryDialog.value = true;
            return;
          }
          if (draftRes.status === 202 && draftJson.message) {
            // Primary agent still deploying — surface a non-fatal note
            // and fall through to the regular chat path so the user still
            // gets *some* response (they can retry once the agent is up).
            console.warn('[chat→patient-summary] draft pending:', draftJson.message);
          } else if (!draftRes.ok) {
            console.warn('[chat→patient-summary] draft failed:', draftJson.error || draftRes.status);
          }
        } catch (err) {
          console.warn('[chat→patient-summary] draft request failed; falling back to raw chat:', err);
        }
      }
    }

    // Build messages with file context
    const messagesWithContext = uploadedFiles.value.length > 0
      ? messages.value.map((msg, index) => {
          // Add file context to the last user message
          if (index === messages.value.length - 1 && msg.role === 'user') {
            const filesContext = uploadedFiles.value.map(file => 
              `File: ${file.name} (${file.type})\nContent:\n${file.type === 'pdf' ? file.content : file.content}`
            ).join('\n\n');
            return {
              ...msg,
              content: `${filesContext}\n\nUser query: ${msg.content}`
            };
          }
          return msg;
        })
      : messages.value;

    const sanitizedMessages = messagesWithContext.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
    
    // Convert displayed label to API key. Capture the label NOW — a
    // concurrent loadProviders() call can reset selectedProvider before
    // the response arrives, mislabeling the response as primary.
    const providerKey = getProviderKey(selectedProvider.value);
    const providerLabel = assistantLabelForKey(providerKey);
    const shareIdForRequest = deepLinkShareId.value || currentSavedChatShareId.value || null;
    const requestOptions: Record<string, unknown> = {
      stream: true
    };
    if (shareIdForRequest) {
      requestOptions.shareId = shareIdForRequest;
    }
    // Tell the server which Private AI agent (Deepseek vs GPT) to use.
    if (providerKey === 'digitalocean' && selectedAgentProfileKey.value) {
      requestOptions.agentProfileKey = selectedAgentProfileKey.value;
    }
    const response = await fetch(
      `/api/chat/${providerKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        credentials: 'include', // Include session cookie
        body: JSON.stringify({
          messages: sanitizedMessages,
          options: requestOptions
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw { message: errorData.error || `HTTP ${response.status}`, status: response.status };
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    const assistantMessage: Message = {
      role: 'assistant',
      content: '',
      authorType: 'assistant',
      providerKey,
      authorId: providerKey,
      authorLabel: providerLabel,
      name: providerLabel
    };
    messages.value.push(assistantMessage);
    // DO NOT update originalMessages here - wait until streaming completes

    // Read stream — with an idle timeout so a hung upstream (no data
    // for N seconds) doesn't leave the user staring at "Thinking…"
    // forever. Server-side also has a finally-block that always emits
    // a terminating isComplete, but a transport-level stall (proxy,
    // network) wouldn't hit that — the client-side timeout is the
    // belt-and-suspenders.
    const STREAM_IDLE_TIMEOUT_MS = 90_000;
    const STREAM_REASONING_TIMEOUT_MS = 300_000;
    const timeoutFor = (ms: number) => new Promise<{ done: true; value: undefined; timeout: true }>(resolve => {
      setTimeout(() => resolve({ done: true, value: undefined, timeout: true }), ms);
    });
    while (true) {
      const idleMs = streamingReasoning.value ? STREAM_REASONING_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
      const result = await Promise.race([
        reader!.read().then(r => ({ ...r, timeout: false })),
        timeoutFor(idleMs)
      ]) as { done: boolean; value?: Uint8Array; timeout?: boolean };
      if (result.timeout) {
        try { reader!.cancel(); } catch { /* ignore */ }
        throw new Error(`Chat request timed out — the Private AI did not respond within ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s. Try again, or reload if the problem persists.`);
      }
      const { done, value } = result;

      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            
            if (data.reasoning) {
              streamingReasoning.value += data.reasoning;
              assistantMessage.reasoningContent = streamingReasoning.value;
            }

            if (data.delta) {
              if (streamingReasoning.value && !reasoningDone.value) {
                reasoningDone.value = true;
              }
              assistantMessage.content += data.delta;
            }

            if (data.isComplete) {
              if (data.reasoningContent) {
                assistantMessage.reasoningContent = data.reasoningContent;
              }
              streamingReasoning.value = '';
              isStreaming.value = false;
              {
                const respLines = (assistantMessage.content || '').split('\n').filter((l: string) => l.trim()).length;
                const respSeconds = Math.round((Date.now() - chatSentAt) / 1000);
                logProvisioningEvent({ event: 'chat-response', provider: chatProvider, lines: respLines, seconds: respSeconds });
              }

              // Save patient summary if this was a summary request
              if (isPatientSummaryRequest && props.user?.userId && assistantMessage.content) {
                await savePatientSummary(assistantMessage.content);
                // Manual (typed) request — offer to jump to the tab.
                if (mentionsSummary && !isUntouchedDefault) {
                  showNewSummaryDialog.value = true;
                }
              }

              // Update originalMessages AFTER streaming completes with full content
              originalMessages.value = JSON.parse(JSON.stringify(messages.value));
              // Update trulyOriginalMessages when assistant response completes (new message added)
              trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
              
              return;
            }
          } catch (e) {
            // Skip malformed JSON
          }
        }
      }
    }

    isStreaming.value = false;

    // Guard: if the stream ended without any content, show an error
    // instead of leaving a blank bubble.
    if (!assistantMessage.content.trim()) {
      assistantMessage.content = `Error: ${assistantLabelForKey(providerKey)} returned an empty response. The service may be temporarily unavailable — try again or choose a different provider.`;
    }

    // Save patient summary if this was a summary request
    if (isPatientSummaryRequest && props.user?.userId && assistantMessage.content) {
      await savePatientSummary(assistantMessage.content);
      if (mentionsSummary && !isUntouchedDefault) {
        showNewSummaryDialog.value = true;
      }
    }

    // Update originalMessages AFTER streaming completes with full content
    originalMessages.value = JSON.parse(JSON.stringify(messages.value));
    // Update trulyOriginalMessages when assistant response completes (new message added)
    trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
  } catch (error) {
    console.error('Chat error:', error);
    
    // Build error message
    let errorMessage = '';
    if (typeof error === 'object' && error !== null && 'status' in error) {
      const errorObj = error as { status?: unknown; message?: string };
      errorMessage = errorObj.message || 'Failed to get response';
      
      // Add special message for 429 rate limit errors
      if (errorObj.status === 429) {
        errorMessage += `\n\n**Your Private AI may be able to handle larger contexts than the ${getProviderLabel()} model.**`;
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;
    } else {
      errorMessage = 'Failed to get response';
    }
    
    logProvisioningEvent({ event: 'chat-error', provider: chatProvider, error: errorMessage, seconds: Math.round((Date.now() - chatSentAt) / 1000) });
    const errorProviderKey = getProviderKey(selectedProvider.value);
    const errorProviderLabel = assistantLabelForKey(errorProviderKey);
    messages.value.push({
      role: 'assistant',
      content: `Error: ${errorMessage}`,
      authorType: 'assistant',
      providerKey: errorProviderKey,
      authorId: errorProviderKey,
      authorLabel: errorProviderLabel,
      name: errorProviderLabel
    });
    originalMessages.value = JSON.parse(JSON.stringify(messages.value)); // Keep original in sync
    // Update trulyOriginalMessages when error message is added (new message)
    trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
    isStreaming.value = false;
  }
};

const handleSignOut = () => {
  logProvisioningEvent({ event: 'sign-out-requested' });
  const providerKey = getProviderKey(selectedProvider.value);
  const providerLabel = getProviderLabelFromKey(providerKey);
  emit('sign-out', {
    currentChat: {
      messages: buildChatHistoryPayload(),
      uploadedFiles: buildUploadedFilePayload(),
      inputMessage: inputMessage.value,
      providerKey,
      providerLabel,
      savedChatId: currentSavedChatId.value,
      savedChatShareId: currentSavedChatShareId.value
    }
  });
};

const stopAgentSetupTimer = () => {
  if (agentSetupTimer) {
    clearInterval(agentSetupTimer);
    agentSetupTimer = null;
  }
};

const getFileNameFromEntry = (file: { fileName?: string; bucketKey?: string }) => {
  if (file.fileName) return file.fileName;
  const key = file.bucketKey || '';
  const parts = key.split('/');
  return parts[parts.length - 1] || '';
};

const loadWizardMessages = async () => {
  try {
    const messagesResponse = await fetch('/api/setup-wizard-messages', {
      credentials: 'include'
    });
    if (messagesResponse.ok) {
      const messagesResult = await messagesResponse.json();
      const payload = messagesResult?.messages;
      if (payload?.messages && typeof payload.messages === 'object') {
        wizardMessages.value = payload.messages;
      }
      wizardIntroLines.value = typeof payload?.intro === 'string'
        ? payload.intro.split('\n')
        : [];
      return;
    }
  } catch (error) {
    // ignore message loading errors
  }
  wizardIntroLines.value = [];
};

const refreshWizardState = async () => {
  await loadWizardMessages();
  const userId = props.user?.userId;
  if (!userId) return;
  let stage3CompleteFromFiles: boolean | null = null;
  let indexingActiveFromFiles: boolean | null = null;
  let indexedCountFromFiles: number | null = null;
  let indexingJobIdFromFiles: string | null = null;
  let tokensFromFiles: string | null = null;
  try {
    const [statusResponse, filesResponse, summaryResponse] = await Promise.all([
      fetch(`/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, {
        credentials: 'include'
      }),
      fetch(`/api/user-files?userId=${encodeURIComponent(props.user.userId)}&source=wizard`, {
        credentials: 'include'
      }),
      fetch(`/api/patient-summary?userId=${encodeURIComponent(props.user.userId)}`, {
        credentials: 'include'
      })
    ]);

    if (wizardStage2NoDeviceKey.value) {
      try {
        wizardStage2NoDevice.value = localStorage.getItem(wizardStage2NoDeviceKey.value) === 'true';
      } catch (error) {
        wizardStage2NoDevice.value = false;
      }
    }

    let statusResult = null;
    if (statusResponse.ok) {
      statusResult = await statusResponse.json();
      if (statusResult?.kbName) {
        wizardKbName.value = statusResult.kbName;
      }
      const hasMeds = !!statusResult?.currentMedications;
      wizardCurrentMedications.value = hasMeds || wizardCurrentMedications.value;
      wizardStage2Complete.value = hasMeds || wizardStage2Complete.value;
      if (statusResult?.hasAppleFile !== undefined && typeof statusResult.hasAppleFile === 'boolean') {
        // Prefer metadata-based detection over stored flag; only use this as a fallback.
        if (!statusResult.hasAppleFile) {
          wizardStage2NoDevice.value = true;
        }
      }
      if (statusResult?.agentReady !== undefined) {
        const wasReady = wizardAgentReady.value;
        wizardAgentReady.value = !!statusResult.agentReady;
        if (wizardAgentReady.value) {
          if (!wizardStage1Complete.value) {
            wizardStage1Complete.value = true;
          }
          // Refetch only on transition (keeps existing behavior)
          if (!wasReady) {
            loadProviders();
          }
          // Ensure secondary agent deploys after primary is ready
          if (!gptAgentReady.value && !wizardSecondaryDeploying.value) {
            wizardDeploySecondary();
          }
        }
      }
      if (statusResult?.initialFile && !wizardStage2FileName.value) {
        wizardStage2FileName.value = getFileNameFromEntry(statusResult.initialFile);
      }
    }

    if (statusResult) {
      // kbIndexingActive is available here from filesResult (parsed
      // above as `indexingActiveFromFiles`). hasPatientSummary is
      // patched in just below once summaryResponse is read — until
      // then we preserve the prior value (undefined → "unknown" →
      // wizard-active computed won't false-trigger).
      const priorHasPatientSummary = userResourceStatus.value?.hasPatientSummary;
      userResourceStatus.value = {
        hasAgent: !!statusResult?.hasAgent,
        kbStatus: statusResult?.kbStatus || 'none',
        hasKB: !!statusResult?.hasKB,
        hasFilesInKB: !!statusResult?.hasFilesInKB,
        workflowStage: statusResult?.workflowStage || null,
        kbIndexingActive: !!indexingActiveFromFiles,
        hasPatientSummary: priorHasPatientSummary,
        hasCurrentMedications: !!statusResult?.currentMedications
      };
      // Whenever server says agent is ready, ensure providers list includes Private AI (no reliance on one-time transitions)
      const agentReady = !!(statusResult?.hasAgent || statusResult?.agentReady);
      if (agentReady && !providers.value.includes('digitalocean')) {
        await loadProviders();
      }
    }

    if (filesResponse.ok) {
      const filesResult = await filesResponse.json();
      const files = Array.isArray(filesResult?.files) ? filesResult.files : [];
      const kbIndexedCount = typeof filesResult?.kbIndexedDataSourceCount === 'number'
        ? filesResult.kbIndexedDataSourceCount
        : null;
      indexedCountFromFiles = kbIndexedCount !== null ? kbIndexedCount : null;
      // Trust backendCompleted from CouchDB over the live DO API status.
      // The DO API can lag behind — it may still report isActive after the backend
      // has already detected completion, causing the wizard to never finish.
      const backendDone = filesResult?.kbIndexingStatus?.backendCompleted === true;
      indexingActiveFromFiles = backendDone ? false : !!filesResult?.kbIndexingActive;
      indexingJobIdFromFiles = filesResult?.kbIndexingJobId || filesResult?.kbLatestJobId || null;
      const liveTokenCount = Number(filesResult?.kbTotalTokens || 0);
      // Complete if backendCompleted, OR if DO API not active and either indexed count > 0 or live tokens > 0
      stage3CompleteFromFiles = backendDone || (!indexingActiveFromFiles && ((indexedCountFromFiles ?? 0) > 0 || liveTokenCount > 0));
      wizardHasFilesInKB.value = (indexedCountFromFiles ?? 0) > 0 || liveTokenCount > 0;
      tokensFromFiles = filesResult?.kbTotalTokens ? String(filesResult.kbTotalTokens) : null;
      const kbFiles = files.filter((file: { inKnowledgeBase?: boolean }) => !!file.inKnowledgeBase);
      const kbName = filesResult?.kbName || wizardKbName.value || '';
      wizardOtherFilesCount.value = kbFiles.length;
      wizardKbName.value = kbName || wizardKbName.value;
      wizardKbTotalTokens.value = tokensFromFiles || wizardKbTotalTokens.value;
      wizardKbIndexedCount.value = kbIndexedCount !== null ? kbIndexedCount : wizardKbIndexedCount.value;
      const fileEntries = files
        .map((file: { fileName?: string; name?: string; bucketKey?: string; isAppleHealth?: boolean; inKnowledgeBase?: boolean; pendingKbAdd?: boolean }) => ({
          name: getFileNameFromEntry(file) || file.fileName || file.name || (file.bucketKey ? String(file.bucketKey).split('/').pop() : ''),
          isAppleHealth: !!file?.isAppleHealth,
          inKnowledgeBase: !!file?.inKnowledgeBase,
          bucketKey: file?.bucketKey,
          pendingKbAdd: !!file?.pendingKbAdd
        }))
        .filter((entry: { name: string }) => !!entry.name);
      const hasAppleHealth = fileEntries.some((entry: { isAppleHealth?: boolean }) => entry.isAppleHealth);
      if (!hasAppleHealth) {
        wizardStage2NoDevice.value = true;
      } else if (wizardStage2NoDevice.value) {
        wizardStage2NoDevice.value = false;
      }
      if (fileEntries.length > 0) {
        wizardStage3Files.value = fileEntries;
      }
      const storedStatus = filesResult?.kbIndexingStatus || null;
      wizardKbIndexedKeys.value = Array.isArray(filesResult?.kbIndexedBucketKeys) ? filesResult.kbIndexedBucketKeys : [];
      if (fileEntries.length > 0) {
        const pendingName = stage3PendingUploadName.value;
        const pendingEntry = pendingName
          ? fileEntries.find((entry: { name: string }) => entry.name === pendingName)
          : null;
        if (pendingEntry?.bucketKey && !pendingEntry.inKnowledgeBase && !wizardAutoCheckedKeys.value.has(pendingEntry.bucketKey)) {
          wizardAutoCheckedKeys.value.add(pendingEntry.bucketKey);
          void toggleWizardKbCheckbox(pendingEntry);
        }
        if (pendingEntry) {
          stage3PendingUploadName.value = null;
          try {
            const pendingKey = props.user?.userId ? `wizardKbPendingFileName-${props.user.userId}` : 'wizardKbPendingFileName';
            localStorage.removeItem(pendingKey);
          } catch (error) {
            // ignore storage errors
          }
        }
      }
      // Persist indexing status when job already completed.
      // Never overwrite a 'complete' phase with stale server data — the
      // frontend poll can detect completion before the server persists
      // backendCompleted, and overwriting here revives the spinner.
      if (stage3CompleteFromFiles !== null && storedStatus && indexingStatus.value?.phase !== 'complete') {
        const storedComplete = storedStatus?.backendCompleted === true || storedStatus?.phase === 'complete';
        indexingStatus.value = {
          active: false,
          phase: storedComplete ? 'complete' : (storedStatus.phase || 'complete'),
          tokens: storedStatus.tokens || tokensFromFiles || '0',
          filesIndexed: storedStatus.filesIndexed || indexedCountFromFiles || 0,
          progress: storedStatus.progress || 1
        };
      }
    }

    if (summaryResponse.ok) {
      const summaryData = await summaryResponse.json();
      const hasSummary = !!(summaryData?.summary && summaryData.summary.trim());
      // If server already has a committed patient summary, mark wizard as complete.
      // BUT during the guided flow (phases running/medications/summary), the user
      // must explicitly verify — don't auto-set from server state, or "Setup
      // complete" fires before the user reviews the summary.
      const inGuidedFlow = wizardFlowPhase.value === 'running'
        || wizardFlowPhase.value === 'medications'
        || wizardFlowPhase.value === 'summary';
      if (hasSummary && !inGuidedFlow) {
        wizardPatientSummary.value = true;
      }
      // Update userResourceStatus so the rail wizard spinner reflects
      // the real "patient summary present?" signal (the field couldn't
      // be set in the main setter above because summaryResponse hadn't
      // been read yet).
      if (userResourceStatus.value) {
        userResourceStatus.value = {
          ...userResourceStatus.value,
          hasPatientSummary: hasSummary
        };
      }
    }

    if (wizardStage2NoDevice.value && (wizardStage2FileName.value || wizardCurrentMedications.value)) {
      wizardStage2NoDevice.value = false;
      if (wizardStage2NoDeviceKey.value) {
        try {
          localStorage.removeItem(wizardStage2NoDeviceKey.value);
        } catch (error) {
          // ignore
        }
      }
    }

      if (indexingActiveFromFiles === true && !isPostRestoreLocked()) {
        wizardStage3Complete.value = false;
        if (!indexingStatus.value || (indexingStatus.value.phase !== 'indexing' && indexingStatus.value.phase !== 'complete')) {
          const stage3Key = wizardStage3IndexingStartedKey(props.user?.userId);
          try {
            const stored = stage3Key ? sessionStorage.getItem(stage3Key) : null;
            if (stored) {
              const startedAt = parseInt(stored, 10);
              const maxAgeMs = 24 * 60 * 60 * 1000;
              if (!isNaN(startedAt) && (Date.now() - startedAt) < maxAgeMs) {
                stage3IndexingStartedAt.value = startedAt;
              } else {
                if (stage3Key) sessionStorage.removeItem(stage3Key);
                stage3IndexingStartedAt.value = Date.now();
                if (stage3Key) sessionStorage.setItem(stage3Key, String(stage3IndexingStartedAt.value));
              }
            } else {
              stage3IndexingStartedAt.value = Date.now();
              if (stage3Key) sessionStorage.setItem(stage3Key, String(stage3IndexingStartedAt.value));
            }
          } catch {
            stage3IndexingStartedAt.value = Date.now();
          }
          stage3IndexingCompletedAt.value = null;
          indexingStatus.value = {
            active: true,
            phase: 'indexing',
            tokens: tokensFromFiles || '0',
            filesIndexed: indexedCountFromFiles || 0,
            progress: 0
          };
          startStage3ElapsedTimer();
          if (indexingJobIdFromFiles) {
            if (stage3IndexingPoll.value) {
              clearInterval(stage3IndexingPoll.value);
            }
            stage3IndexingPoll.value = setInterval(async () => {
              try {
                const statusResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(props.user?.userId || '')}&source=wizard`, {
                  credentials: 'include'
                });
                if (!statusResponse.ok) {
                  throw new Error(`Indexing status error: ${statusResponse.status}`);
                }
                const statusResult = await statusResponse.json();
                const storedStatus = statusResult?.kbIndexingStatus || {};
                const liveActive = !!statusResult?.kbIndexingActive;
                const backendDone = storedStatus.backendCompleted === true;
                // Fix: '0' is truthy in JS, so use Number() to properly fall through to kbTotalTokens
                const storedTokens = storedStatus.tokens;
                const liveTokens = statusResult?.kbTotalTokens ? String(statusResult.kbTotalTokens) : '0';
                const tokens = (Number(storedTokens) > 0) ? storedTokens : liveTokens;
                const elapsedPollMs = stage3IndexingStartedAt.value ? Date.now() - stage3IndexingStartedAt.value : 0;
                // (Verbose per-poll console log removed. maia-log
                // captures completion via logProvisioningEvent.)
                if (storedStatus.jobId && indexingJobIdFromFiles && storedStatus.jobId !== indexingJobIdFromFiles) {
                  return;
                }
                if (indexingStatus.value) {
                  indexingStatus.value.phase = storedStatus.phase || indexingStatus.value.phase;
                  indexingStatus.value.tokens = tokens;
                  indexingStatus.value.filesIndexed = storedStatus.filesIndexed || 0;
                  indexingStatus.value.progress = storedStatus.progress || 0;
                }
                // Also treat as complete if DO API says not active and tokens > 0
                // (covers edge case where backend polling crashed before setting backendCompleted)
                const inferredComplete = !liveActive && Number(tokens) > 0;
                // Also complete if DO API says not active for > 5 minutes (handles 0-token edge case)
                const timedOutInactive = !liveActive && !backendDone && elapsedPollMs > 5 * 60 * 1000;
                // Client-side safety net: tokens > 0 for > 7 minutes AND every expected
                // file already indexed. See handleStage3Index for the rationale.
                const filesIndexedSoFar = Number(storedStatus.filesIndexed) || 0;
                const allExpectedFilesIndexed = stage3ExpectedFileCount.value > 0
                  ? filesIndexedSoFar >= stage3ExpectedFileCount.value
                  : filesIndexedSoFar > 0;
                const tokenTimeoutComplete = !backendDone && !inferredComplete && Number(tokens) > 0 && elapsedPollMs > 7 * 60 * 1000 && allExpectedFilesIndexed;
                // Pure time-based fallback: 30+ min with no completion signal at all.
                const pureTimeoutComplete = !backendDone && !inferredComplete && !tokenTimeoutComplete && elapsedPollMs > 30 * 60 * 1000;
                const isCompleted = backendDone || inferredComplete || timedOutInactive || tokenTimeoutComplete || pureTimeoutComplete;
                if (isCompleted) {
                  if (stage3IndexingPoll.value) {
                    clearInterval(stage3IndexingPoll.value);
                    stage3IndexingPoll.value = null;
                  }
                  if (indexingStatus.value) {
                    indexingStatus.value.active = false;
                    indexingStatus.value.phase = 'complete';
                  }
                  stage3IndexingCompletedAt.value = Date.now();
                  stopStage3ElapsedTimer();
                  try {
                    const k = wizardStage3IndexingStartedKey(props.user?.userId);
                    if (k) sessionStorage.removeItem(k);
                  } catch { /* ignore */ }
                  refreshWizardState();
                }
              } catch (pollError) {
                console.warn('[KB-POLL] Error:', pollError);
              }
            }, 10000);
          }
        }
      } else if (stage3CompleteFromFiles !== null) {
        wizardStage3Complete.value = stage3CompleteFromFiles;
        // Only re-create indexingStatus if it was never completed before.
        // Without this guard, every refreshWizardState() call after indexing
        // re-creates the status (null → complete), triggering the watcher
        // to log a duplicate "Indexing Complete" entry.
        if (stage3CompleteFromFiles && !indexingStatus.value && !stage3IndexingCompletedAt.value) {
          indexingStatus.value = {
            active: false,
            phase: 'complete',
            tokens: tokensFromFiles || '0',
            filesIndexed: indexedCountFromFiles || 0,
            progress: 1
          };
        }
        if (indexingStatus.value?.phase !== 'indexing' && !wizardPreparingRecords.value) {
          stopStage3ElapsedTimer();
        }
      }
      if (wizardUserStorageKey.value) {
        const stored = localStorage.getItem(wizardUserStorageKey.value);
        if (stored) {
          try {
            const parsed = JSON.parse(stored);
            if (!indexingActiveFromFiles && !stage3IndexingActive.value) {
              wizardStage3Complete.value = !!parsed.stage2Complete || wizardStage3Complete.value;
            }
            wizardStage2Complete.value = !!parsed.stage3Complete || wizardStage2Complete.value;
            wizardPatientSummary.value = !!parsed.stage4Complete || wizardPatientSummary.value;
          } catch (error) {
            // Ignore malformed storage
          }
        }
      }
      persistWizardCompletion();
  } catch (error) {
    console.warn('Failed to refresh setup wizard state:', error);
  }
};

const shouldHideSetupWizard = computed(() =>
  (!wizardRestoreActive.value && wizardPatientSummary.value) || !!props.user?.isAdmin || !!props.suppressWizard
);

const savePatientSummary = async (summary: string) => {
  if (!props.user?.userId || !summary) return;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.user.userId,
        summary: summary
      })
    });
    
    if (!response.ok) {
      console.error('Failed to save patient summary');
    }
  } catch (error) {
    console.error('Error saving patient summary:', error);
  }
};

const triggerFileInput = () => {
  if (isRequestSent.value) return;
  fileInput.value?.click();
};

const handleWizardFileSelect = () => {
  logWizardEvent('stage2_file_selected', { tab: 'wizard' });
  wizardUploadIntent.value = null;
  refreshWizardState();
};

const toggleWizardKbCheckbox = async (file: { bucketKey?: string | null; inKnowledgeBase?: boolean }) => {
  const userId = props.user?.userId;
  if (!userId || !file?.bucketKey) return;
  const bucketKey = file.bucketKey;
  if (wizardKbTogglePending.value.has(bucketKey)) return;
  wizardKbTogglePending.value.add(bucketKey);
  const nextValue = !file.inKnowledgeBase;
  try {
    const response = await fetch('/api/toggle-file-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId,
        bucketKey,
        inKnowledgeBase: nextValue
      })
    });
    if (!response.ok) {
      throw new Error(`Failed to update KB selection (${response.status})`);
    }
    file.inKnowledgeBase = nextValue;
    wizardStage3Files.value = wizardStage3Files.value.map(entry =>
      entry.bucketKey === bucketKey ? { ...entry, inKnowledgeBase: nextValue } : entry
    );
    // File moved to/from KB folder or archived — remove from chat badges and context
    handleFilesArchived([bucketKey]);
    await refreshWizardState();
  } catch (error) {
    console.error('Failed to toggle KB selection:', error);
  } finally {
    wizardKbTogglePending.value.delete(bucketKey);
  }
};

const dismissWizard = () => {
  wizardDismissed.value = true;
  showAgentSetupDialog.value = false;
  stopAgentSetupTimer();
  if (initialLoadComplete.value && providers.value.length > 0 && !providers.value.includes('digitalocean')) {
    showPrivateUnavailableDialog.value = true;
    selectFirstNonPrivateProvider();
  }
};

// ── Local Folder: pick, auto-run, PDF log ────────────────────────

/** Parse navigator.userAgent into a human-readable string, e.g. "Chrome 145 on macOS". */
const parseUserAgent = (): string => {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  // Detect browser
  let browser = 'Unknown browser';
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const firefoxMatch = ua.match(/Firefox\/(\d+)/);
  const safariMatch = ua.match(/Version\/(\d+).*Safari/);
  const edgeMatch = ua.match(/Edg\/(\d+)/);
  if (edgeMatch) browser = `Edge ${edgeMatch[1]}`;
  else if (chromeMatch) browser = `Chrome ${chromeMatch[1]}`;
  else if (firefoxMatch) browser = `Firefox ${firefoxMatch[1]}`;
  else if (safariMatch) browser = `Safari ${safariMatch[1]}`;
  // Detect OS
  let os = 'Unknown OS';
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) os = 'macOS';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  return `${browser} on ${os}`;
};


/** TEST button — sets auto-pilot mode and triggers the normal folder picker flow. */
const handleTestButton = async () => {
  testMode.value = true;
  testLogLines.value = [];
  testFinalOutput.value = '';
  testSetupVerification.value = null;
  addTestLog('TEST mode activated — wizard will auto-verify');

  // Clean up orphaned cloud resources from any previous interrupted TEST run.
  // This prevents agents, KBs, and Spaces files from accumulating.
  // Uses /api/local/delete (unauthenticated) to avoid session issues.
  if (props.user?.userId) {
    try {
      const statusRes = await fetch(`/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, { credentials: 'include' });
      if (statusRes.ok) {
        const status = await statusRes.json();
        if (status.hasAgent || status.hasKB || status.fileCount > 0) {
          addTestLog('Cleaning up previous test resources...');
          console.log('[TEST] Pre-cleanup: found existing resources, deleting...');
          const delRes = await fetch('/api/local/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ userId: props.user.userId })
          });
          if (delRes.ok) {
            console.log('[TEST] Pre-cleanup complete');
            addTestLog('Previous resources cleaned up');
          } else {
            console.error('[TEST] Pre-cleanup failed:', delRes.status);
            addTestLog('Cleanup partial — continuing anyway', false);
          }
          // Recreate account so wizard can proceed
          const recreateRes = await fetch('/api/account/recreate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ userId: props.user.userId })
          });
          if (!recreateRes.ok) {
            addTestLog('Account recreate failed — aborting', false);
            testMode.value = false;
            return;
          }
        }
      }
    } catch (e: any) {
      console.error('[TEST] Pre-cleanup error:', e);
      addTestLog(`Pre-cleanup check failed: ${e.message} — continuing`, false);
    }
  }

  logProvisioningEvent({ event: 'test-started' });
  void generateSetupLogPdf();

  // If we already have a folder handle (from current session), reuse it
  // instead of showing a redundant showDirectoryPicker dialog.
  if (localFolderHandle.value) {
    try {
      const files = await listFolderFiles(localFolderHandle.value, { extensions: ['pdf'] });
      localFolderFiles.value = files;
    } catch { localFolderFiles.value = []; }
    wizardFlowPhase.value = 'running';
    wizardTimeoutTimer = setTimeout(async () => {
      if (showAgentSetupDialog.value && localFolderHandle.value) {
        await generateSetupLogPdf();
        wizardTimeoutModalVisible.value = true;
      }
    }, 60 * 60 * 1000);
    await runAutoWizard();
    return;
  }

  // No folder handle — trigger the normal folder picker
  handlePickLocalFolder();
};

/** User clicks "Select your MAIA folder" — opens directory picker, scans files, starts auto-run. */
const handlePickLocalFolder = async () => {
  if (!props.user?.userId) return;
  const result = await pickLocalFolder(props.user.userId);
  if (!result) return; // user cancelled
  localFolderHandle.value = result.handle;
  localFolderName.value = result.folderName;
  emit('local-folder-connected', { handle: result.handle, folderName: result.folderName });

  // Write maia.webloc shortcut immediately (with userId if available; patient name added at wizard completion)
  try {
    await writeWeblocFile(result.handle, window.location.origin, {
      userId: props.user?.userId || undefined
    });
  } catch (e) {
    // ignore shortcut write errors
  }

  // Scan folder for PDF files
  try {
    const files = await listFolderFiles(result.handle, { extensions: ['pdf'] });
    localFolderFiles.value = files;
  } catch (e) {
    localFolderFiles.value = [];
  }

  // Start 60-minute timeout
  wizardTimeoutTimer = setTimeout(async () => {
    if (showAgentSetupDialog.value && localFolderHandle.value) {
      await generateSetupLogPdf();
      wizardTimeoutModalVisible.value = true;
    }
  }, 60 * 60 * 1000);

  // Start auto-run wizard — set guided flow phase to 'running'
  wizardFlowPhase.value = 'running';
  await runAutoWizard();
};

/** Safari: user clicks "Select your MAIA folder" — opens webkitdirectory input, scans files, starts auto-run. */
const handlePickSafariFolder = () => {
  safariFolderInputRef.value?.click();
};

/** Safari: files selected via webkitdirectory input */
const handleSafariFolderSelected = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (!input.files || input.files.length === 0) return;
  if (!props.user?.userId) return;

  // Collect PDF files from the folder
  const allFiles = Array.from(input.files);
  const pdfs = allFiles.filter(f => f.name.toLowerCase().endsWith('.pdf') && !f.name.startsWith('.'));

  // Extract folder name from webkitRelativePath (e.g. "MAIA/file.pdf" → "MAIA")
  const firstPath = allFiles[0]?.webkitRelativePath || '';
  const folderName = firstPath.split('/')[0] || 'Selected Folder';
  safariFolderName.value = folderName;
  safariNeedsReselect.value = false;
  safariFolderFiles.value = pdfs;

  // Persist safari folder name so we can recover wizard state on reload
  try {
    const sfKey = `safariFolderName-${props.user.userId}`;
    localStorage.setItem(sfKey, folderName);
  } catch { /* ignore */ }

  // Populate localFolderFiles with compatible entries (no fileHandle — Safari doesn't provide one)
  localFolderFiles.value = pdfs.map(f => ({
    name: f.name,
    size: f.size,
    lastModified: f.lastModified,
    fileHandle: null as any, // Not available in Safari
  }));

  localFolderName.value = folderName;

  // Start 60-minute timeout
  wizardTimeoutTimer = setTimeout(async () => {
    if (showAgentSetupDialog.value) {
      wizardTimeoutModalVisible.value = true;
    }
  }, 60 * 60 * 1000);

  wizardFlowPhase.value = 'running';
  await runSafariFolderWizard(pdfs);
};

/** Safari auto-wizard: upload files from webkitdirectory → deploy agent → index KB.
 *  Same flow as Chrome wizard but files come from File objects, not FileSystemFileHandle. */
const runSafariFolderWizard = async (files: File[]) => {
  if (!props.user?.userId) return;
  localFolderAutoRunActive.value = true;

  try {
    // Phase 1: Upload PDFs
    localFolderAutoRunPhase.value = 'Uploading files...';
    const MAIA_GENERATED_FILES = ['maia-log.pdf'];
    const filesToUpload = files.filter(f => !MAIA_GENERATED_FILES.includes(f.name.toLowerCase()));

    let uploadedCount = 0;
    let appleHealthCount = 0;
    const uploadedFileNames: string[] = [];
    let totalUploadedBytes = 0;
    let appleHealthFileName: string | null = null;
    for (const file of filesToUpload) {
      try {
        const maxSize = 50 * 1024 * 1024;
        if (file.size > maxSize) {
          continue;
        }
        localFolderAutoRunPhase.value = `Uploading ${file.name}...`;
        const uploadFormData = new FormData();
        uploadFormData.append('file', file);
        const uploadResponse = await fetch('/api/files/upload', {
          method: 'POST',
          credentials: 'include',
          body: uploadFormData
        });
        if (!uploadResponse.ok) {
          continue;
        }
        const uploadResult = await uploadResponse.json();

        // Detect Apple Health
        let isAppleHealth = false;
        try {
          isAppleHealth = await detectAppleHealthFromBucket(uploadResult.fileInfo.bucketKey);
          if (isAppleHealth) {
            appleHealthCount++;
            appleHealthFileName = file.name;
          }
        } catch { /* ignore detection errors */ }

        // Save file metadata
        await fetch('/api/user-file-metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.user!.userId,
            fileMetadata: {
              fileName: uploadResult.fileInfo.fileName,
              bucketKey: uploadResult.fileInfo.bucketKey,
              bucketPath: uploadResult.fileInfo.userFolder,
              fileSize: uploadResult.fileInfo.size,
              fileType: 'pdf',
              uploadedAt: uploadResult.fileInfo.uploadedAt,
              isAppleHealth
            },
            updateInitialFile: false
          })
        });

        uploadedCount++;
        uploadedFileNames.push(file.name);
        totalUploadedBytes += file.size;
      } catch { /* ignore per-file upload errors */ }
    }
    logProvisioningEvent({
      event: 'files-uploaded',
      count: uploadedCount,
      totalKB: Math.round(totalUploadedBytes / 1024),
      files: uploadedFileNames,
      appleHealthCount
    });
    if (appleHealthFileName) {
      logProvisioningEvent({ event: 'apple-health-detected', fileName: appleHealthFileName });
    }

    // Refresh wizard state and wait for every uploaded file to surface (see
    // runAutoWizard for the same pattern; CouchDB read-after-write lag can
    // cause a partial file list otherwise).
    await refreshWizardState();
    for (let waitAttempt = 0; waitAttempt < 10; waitAttempt += 1) {
      const visibleNames = new Set(wizardStage3Files.value.map(f => f.name));
      const missing = uploadedFileNames.filter(n => !visibleNames.has(n));
      if (missing.length === 0) break;
      await new Promise(r => setTimeout(r, 500));
      await refreshWizardState();
    }

    // Phase 2: Check agent
    localFolderAutoRunPhase.value = 'Checking agent deployment...';

    // Phase 3: Index KB
    if (uploadedCount > 0) {
      localFolderAutoRunPhase.value = 'Starting knowledge base indexing...';
      try {
        if (uploadedFileNames.length > 0) {
          await handleStage3Index(uploadedFileNames, false);
          localFolderAutoRunPhase.value = 'Knowledge base indexing in progress...';
        }
      } catch (err) {
        console.warn('[Wizard] handleStage3Index threw:', err);
      }
    }

    if (uploadedCount > 0) {
      localFolderAutoRunPhase.value = 'Knowledge base indexing in progress...';
    } else {
      localFolderAutoRunPhase.value = 'Setup complete';
    }
  } catch (e) {
    localFolderAutoRunPhase.value = 'Setup completed with errors';
  } finally {
    localFolderAutoRunActive.value = false;
  }
};

/** Try to silently reconnect to a previously chosen local folder. */
const tryReconnectLocalFolder = async () => {
  if (!props.user?.userId || !isFileSystemAccessSupported()) return;
  const result = await reconnectLocalFolder(props.user.userId);
  if (!result) return;
  localFolderHandle.value = result.handle;
  localFolderName.value = result.folderName;
  emit('local-folder-connected', { handle: result.handle, folderName: result.folderName });
  // Scan folder for new files silently
  try {
    const files = await listFolderFiles(result.handle, { extensions: ['pdf'] });
    localFolderFiles.value = files;
  } catch {
    // ignore — folder may be unavailable
  }
};

/** Auto-run wizard: upload folder files → deploy agent → index KB → detect Apple Health → generate summary. */
const runAutoWizard = async () => {
  if (!props.user?.userId || !localFolderHandle.value) return;
  localFolderAutoRunActive.value = true;
  // Add session separator (preserves full history from previous sessions)

  try {
    // Phase 1: Upload PDFs from folder to Spaces
    localFolderAutoRunPhase.value = 'Uploading files...';
    const MAIA_GENERATED_FILES = ['maia-log.pdf'];
    const filesToUpload = localFolderFiles.value.filter(f => {
      const name = f.name.toLowerCase();
      return name.endsWith('.pdf') && !MAIA_GENERATED_FILES.includes(name);
    });
    let uploadedCount = 0;
    let appleHealthCount = 0;
    const uploadedFileNames: string[] = [];
    let totalUploadedBytes = 0;
    let appleHealthFileName: string | null = null;
    for (const fileEntry of filesToUpload) {
      try {
        const file = await fileEntry.fileHandle.getFile();
        // Check size
        const maxSize = 50 * 1024 * 1024;
        if (file.size > maxSize) {
          continue;
        }
        localFolderAutoRunPhase.value = `Uploading ${file.name}...`;
        // Upload to bucket
        const uploadFormData = new FormData();
        uploadFormData.append('file', file);
        const uploadResponse = await fetch('/api/files/upload', {
          method: 'POST',
          credentials: 'include',
          body: uploadFormData
        });
        if (!uploadResponse.ok) {
          continue;
        }
        const uploadResult = await uploadResponse.json();

        // Detect Apple Health
        let isAppleHealth = false;
        try {
          isAppleHealth = await detectAppleHealthFromBucket(uploadResult.fileInfo.bucketKey);
          if (isAppleHealth) {
            appleHealthCount++;
            appleHealthFileName = file.name;
          }
        } catch { /* ignore detection errors */ }

        // Save file metadata
        await fetch('/api/user-file-metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.user!.userId,
            fileMetadata: {
              fileName: uploadResult.fileInfo.fileName,
              bucketKey: uploadResult.fileInfo.bucketKey,
              bucketPath: uploadResult.fileInfo.userFolder,
              fileSize: uploadResult.fileInfo.size,
              fileType: 'pdf',
              uploadedAt: uploadResult.fileInfo.uploadedAt,
              isAppleHealth
            },
            updateInitialFile: false
          })
        });

        uploadedCount++;
        uploadedFileNames.push(file.name);
        totalUploadedBytes += file.size;
      } catch { /* ignore per-file upload errors */ }
    }
    logProvisioningEvent({
      event: 'files-uploaded',
      count: uploadedCount,
      totalKB: Math.round(totalUploadedBytes / 1024),
      files: uploadedFileNames,
      appleHealthCount
    });
    if (appleHealthFileName) {
      logProvisioningEvent({ event: 'apple-health-detected', fileName: appleHealthFileName });
    }

    // Refresh wizard state to pick up new files. Retry until every just-uploaded
    // file is visible in wizardStage3Files (the server reads userDoc.files which
    // has read-after-write lag right after the metadata POSTs). Without this
    // wait, handleStage3Index can be called with a partial file list and only
    // a subset of files end up in the KB folder before indexing fires.
    await refreshWizardState();
    for (let waitAttempt = 0; waitAttempt < 10; waitAttempt += 1) {
      const visibleNames = new Set(wizardStage3Files.value.map(f => f.name));
      const missing = uploadedFileNames.filter(n => !visibleNames.has(n));
      if (missing.length === 0) break;
      await new Promise(r => setTimeout(r, 500));
      await refreshWizardState();
    }

    // Phase 2: Check agent deployment status
    localFolderAutoRunPhase.value = 'Checking agent deployment...';

    // Phase 3: Move files to KB and trigger indexing immediately (KB creation is independent of agent)
    if (uploadedCount > 0) {
      localFolderAutoRunPhase.value = 'Starting knowledge base indexing...';
      try {
        // Pass the names of files we KNOW we just uploaded (not whatever
        // wizardStage3Files currently has — those can be partial during
        // CouchDB read-after-write lag).
        if (uploadedFileNames.length > 0) {
          await handleStage3Index(uploadedFileNames, false);
          localFolderAutoRunPhase.value = 'Knowledge base indexing in progress...';
        }
      } catch (err) {
        console.warn('[Wizard] handleStage3Index threw:', err);
      }
    }

    // Phase 4: Generate setup log PDF
    await generateSetupLogPdf();

    // Phase 5: Write initial maia-state.json
    await saveStateToLocalFolder();

    if (uploadedCount > 0) {
      localFolderAutoRunPhase.value = 'Knowledge base indexing in progress...';
    } else {
      localFolderAutoRunPhase.value = 'Setup complete';
    }
  } catch (e) {
    localFolderAutoRunPhase.value = 'Setup completed with errors';
  } finally {
    localFolderAutoRunActive.value = false;
  }
};

/** Generate maia-log.pdf summary and write to local folder. */
const generateSetupLogPdf = async () => {
  if (!localFolderHandle.value) return;
  // Refresh providers right before rendering so a freshly deployed agent (e.g. after
  // a long restore) is reflected in the "Chat providers:" header. Without this, the
  // PDF can be generated before the post-restore providers refetch settles.
  try { await loadProviders(); } catch { /* non-fatal */ }
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  const maxWidth = pageWidth - margin * 2;
  let y = 20;

  // Header
  doc.setFontSize(18);
  doc.text('MAIA Setup Log', margin, y);
  y += 10;
  doc.setFontSize(10);
  doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
  y += 6;
  doc.text(`Version: ${packageJson.version}`, margin, y);
  y += 6;
  doc.text(`User: ${props.user?.userId || 'unknown'}`, margin, y);
  y += 6;
  doc.text(`App URL: ${window.location.origin}`, margin, y);
  y += 6;
  doc.text(`Folder: ${localFolderName.value || 'unknown'}`, margin, y);
  y += 6;
  const ua = parseUserAgent();
  doc.text(`Browser: ${ua}`, margin, y);
  y += 6;
  // API versions
  const availableApis = providers.value.map(p => {
    const label = providerLabels[p] || p;
    if (p === 'digitalocean') return `${label} (openai-gpt-oss-120b)`;
    if (p === 'anthropic') return `${label} (claude-opus-4-6)`;
    return label;
  }).join(', ');
  doc.text(`Chat providers: ${availableApis || 'none'}`, margin, y);
  y += 8;

  // Summary section
  doc.setFontSize(11);
  doc.text('Summary', margin, y);
  y += 6;
  doc.setFontSize(9);
  const totalFiles = wizardStage3Files.value.length;
  const hasIndexing = indexingStatus.value?.phase === 'complete';
  const indexTokens = indexingStatus.value?.tokens || '0';
  const hasSummary = wizardPatientSummary.value;
  const summaryItems = [
    `Files uploaded: ${totalFiles}`,
    `${labelForProfileKey('default')} ready: ${wizardStage1Complete.value ? 'Yes' : 'No'}`,
    `${labelForProfileKey('gpt')} ready: ${gptAgentReady.value ? 'Yes' : 'Pending'}`,
    `KB indexed: ${hasIndexing ? 'Yes' : 'Pending'} (${indexTokens} tokens)`,
    `Current Medications: ${wizardCurrentMedications.value ? 'Verified' : 'Pending verification'}`,
    `Medication Worksheets: see Lists (generate on demand)`,
    `Patient Summary: ${hasSummary ? 'Yes' : 'No'}`
  ];
  for (const item of summaryItems) {
    doc.text(`  ${item}`, margin, y);
    y += 5;
  }
  y += 6;
  // Detailed log from server provisioning log
  doc.setFontSize(11);
  doc.text('Detailed Log', margin, y);
  y += 6;
  doc.setFontSize(9);

  try {
    // Fetch server events and merge with locally-saved events (from before account deletion)
    let serverEvents: Array<Record<string, any>> = [];
    try {
      const logRes = await fetch(`/api/provisioning-log?userId=${encodeURIComponent(props.user?.userId || '')}`, { credentials: 'include' });
      if (logRes.ok) {
        const logData = await logRes.json();
        serverEvents = logData.log || [];
      }
    } catch { /* server unavailable */ }

    // Read locally-saved events from maia-state.json (preserves events from before account deletion)
    let localEvents: Array<Record<string, any>> = [];
    if (localFolderHandle.value) {
      try {
        const state = await readStateFile(localFolderHandle.value);
        if (state?.provisioningLog && Array.isArray(state.provisioningLog)) {
          localEvents = state.provisioningLog;
        }
      } catch { /* no local state */ }
    }

    // Buffered events: provisioning events whose server POST failed
    // (session gone during sign-out / cloud destroy). Without these the
    // maia-log.pdf would silently omit errors that happened after the
    // cloud was torn down. "maia-log must always show errors/warnings."
    let bufferedEvents: Array<Record<string, any>> = [];
    try {
      const { readBufferedLogEvents } = await import('../utils/localFolder');
      const uid = props.user?.userId;
      bufferedEvents = readBufferedLogEvents().filter(e => !e.userId || e.userId === uid);
    } catch { /* ignore */ }

    // Merge: deduplicate by compound key (id+time) to handle ID collisions after account recreation
    // After account deletion and recreation, server resets IDs from 1, so bare id dedup would
    // incorrectly filter out all restore events when setup events had the same IDs.
    const eventKey = (e: Record<string, any>) => `${e.id ?? ''}-${e.time ?? ''}-${e.event ?? ''}`;
    const seen = new Set<string>();
    const events: Array<Record<string, any>> = [];
    for (const e of [...localEvents, ...serverEvents, ...bufferedEvents]) {
      const k = eventKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      events.push(e);
    }
    events.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    if (events.length > 0) {

      const formatElapsed = (ms: number): string => {
        const m = Math.floor(ms / 60000);
        const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
        return `${m}m ${s}s`;
      };

      // Color helper for provisioning events
      const getEventColor = (evt: Record<string, any>): [number, number, number] => {
        if (evt.event === 'error') return [200, 0, 0];
        if (evt.event === 'account-deleted') return [200, 0, 0];
        if (evt.event === 'patient-consistency-mismatch') return [200, 0, 0];
        if (evt.event === 'patient-identity-extraction-failed') return [200, 0, 0];
        if (evt.event?.startsWith('test-')) return [200, 100, 0];
        if (evt.event === 'medications-saved' || evt.event === 'summary-saved' ||
            evt.event === 'medications-restored' || evt.event === 'summary-restored' ||
            evt.event === 'summary-verified') return [0, 120, 0];
        if (evt.event === 'medications-offered' && evt.outcome && evt.outcome !== 'success') return [180, 100, 0];
        if (evt.event === 'current-medications-recovery-failed') return [200, 0, 0];
        if (evt.event === 'draft-summary-failed' || evt.event === 'meds-worksheet-failed'
            || evt.event === 'draft-summary-primary-failed' || evt.event === 'draft-summary-primary-retry-failed'
            || evt.event === 'draft-summary-fallback-failed') return [200, 0, 0];
        if (evt.event === 'draft-summary-fallback-started' || evt.event === 'draft-summary-primary-key-recreated'
            || evt.event === 'secondary-provision-timeout') return [180, 100, 0];
        if (evt.event === 'draft-summary-fallback-succeeded') return [0, 120, 0];
        if (evt.event === 'chat-error') return [200, 0, 0];
        if (evt.event === 'meds-worksheet-pending') return [180, 100, 0];
        if (evt.event === 'gpt-agent-created' || evt.event === 'gpt-agent-deployed' || evt.event === 'gpt-agent-ready') return [0, 90, 160];
        return [0, 0, 0];
      };

      // Format event to human-readable line
      const formatEvent = (evt: Record<string, any>): string => {
        const t = evt.time ? new Date(evt.time).toLocaleTimeString() : '??:??';
        switch (evt.event) {
          case 'setup-started': return `[${t}] Setup started`;
          case 'setup-resumed':
            return `[${t}] Setup reopened to finish verification — the Patient Summary from the previous session was still a draft (not verified). This is a resume, not a new setup.`;
          case 'restore-started': return `[${t}] Restore started`;
          case 'setup-complete': return `[${t}] Setup complete`;
          case 'restore-complete': return `[${t}] Restore complete`;
          case 'account-deleted': return `[${t}] Cloud account deleted`;
          case 'files-uploaded': {
            const parts = [`${evt.count || 0} files`];
            if (evt.totalKB) parts.push(`(${Number(evt.totalKB).toLocaleString()} KB)`);
            if (evt.appleHealthCount) parts.push(`${evt.appleHealthCount} Apple Health`);
            if (evt.failedCount) parts.push(`${evt.failedCount} failed`);
            return `[${t}] Files uploaded: ${parts.join(', ')}`;
          }
          case 'apple-health-detected': return `[${t}] Apple Health detected: ${evt.fileName || ''}`;
          case 'agent-deployed': return `[${t}] ${labelForProfileKey('default')} deployed and available${evt.elapsedMs ? ` (${formatElapsed(evt.elapsedMs)})` : ''}`;
          case 'kb-indexed': {
            const parts = [];
            if (evt.fileCount) parts.push(`${evt.fileCount} files`);
            if (evt.tokens) parts.push(`${Number(evt.tokens).toLocaleString()} tokens`);
            if (evt.elapsedMs) parts.push(formatElapsed(evt.elapsedMs));
            return `[${t}] KB indexed: ${parts.join(', ')}`;
          }
          case 'kb-created': {
            const lines = [`[${t}] Knowledge base created: ${evt.kbName || ''}`];
            const add = (label: string, v: unknown) => { if (v) lines.push(`        ${label}: ${v}`); };
            add('KB id', evt.kbId);
            add('Embedding model', evt.embeddingModelName || evt.embeddingModelId);
            add('Reranking model', evt.rerankingModel);
            if (evt.chunkingAlgorithm) {
              const algo = String(evt.chunkingAlgorithm).replace('CHUNKING_ALGORITHM_', '').toLowerCase();
              const opts = evt.chunkingOptions
                ? Object.entries(evt.chunkingOptions).map(([k, v]) => `${k}=${v}`).join(', ')
                : '';
              lines.push(`        Chunking: ${algo}${opts ? ` (${opts})` : ''}`);
            }
            add('OpenSearch database id', evt.databaseId);
            add('Project id', evt.projectId);
            add('Region', evt.region);
            add('Bucket', evt.bucketName);
            add('Data source path', evt.itemPath);
            if (evt.role) lines.push(`        Role: ${evt.role}`);
            return lines.join('\n');
          }
          case 'clean-index-built':
            return `[${t}] Footer-stripped index built (${evt.fileCount || 0} file(s)) — KB indexes cleaned text`;
          case 'kb-connection-changed': {
            const verb = evt.action === 'connected' ? 'Connected' : 'Disconnected';
            const prep = evt.action === 'connected' ? 'to' : 'from';
            const agent = labelForProfileKey(evt.agentProfileKey === 'gpt' ? 'gpt' : 'default');
            const role = evt.kbRole ? ` [${evt.kbRole}]` : '';
            return `[${t}] ${verb} ${evt.kbName || evt.kbKey}${role} ${prep} ${agent}`;
          }
          case 'summary-generated': return `[${t}] Patient Summary generated (${evt.lines || 0} lines, ${Number(evt.chars || 0).toLocaleString()} chars)`;
          case 'draft-summary-generated': {
            const secs = typeof evt.generationSeconds === 'number' ? ` in ${evt.generationSeconds}s` : '';
            return `[${t}] Draft Patient Summary saved (${evt.lines || 0} lines, ${Number(evt.chars || 0).toLocaleString()} chars${secs}) — hidden until verified`;
          }
          case 'medications-offered': {
            const src = evt.source ? ` from ${String(evt.source).replace(/-/g, ' ')}` : '';
            const outcome = evt.outcome && evt.outcome !== 'success' ? ` [${evt.outcome}]` : '';
            return `[${t}] Medications offered for verification (${evt.lines || 0} lines)${src}${outcome}`;
          }
          case 'medications-extract-skipped':
            return `[${t}] AI medication extraction skipped (${evt.reason || 'unknown'}) — used patient-summary medications instead`;
          case 'meds-worksheet-generated': {
            const agent = labelForProfileKey(evt.agentProfileKey === 'gpt' ? 'gpt' : 'default');
            const model = evt.model ? ` [${evt.model}]` : '';
            const files = evt.fileCount ? `, ${evt.fileCount} source file(s)` : '';
            const src = evt.sourceMode === 'apple-health-markdown'
              ? ', source: Apple Health medication records'
              : (evt.sourceMode === 'epic-medication-list' ? ', source: Epic medication list (dated)'
              : (evt.sourceMode === 'kb-retrieval' ? ', source: knowledge-base retrieval' : ''));
            return `[${t}] Current Medications Worksheet generated — ${agent}${model}${files}${src}`;
          }
          case 'gpt-agent-created': return `[${t}] ${labelForProfileKey('gpt')} agent created — deploying`;
          case 'gpt-agent-deployed':
          case 'gpt-agent-ready': return `[${t}] ${labelForProfileKey('gpt')} deployed and available`;
          case 'encounters-worksheet-generated':
            return `[${t}] Encounters list built (${evt.encounterCount || 0} encounters from ${evt.fileCount || 0} file(s))`;
          case 'draft-summary-failed':
            return `[${t}] Draft Patient Summary FAILED${evt.status ? ` (HTTP ${evt.status})` : ''}${evt.reason ? ` — ${evt.reason}` : ''}`;
          case 'meds-worksheet-failed': {
            const agent = labelForProfileKey(evt.agentProfileKey === 'gpt' ? 'gpt' : 'default');
            return `[${t}] Medications Worksheet FAILED — ${agent}${evt.status ? ` (HTTP ${evt.status})` : ''}${evt.reason ? ` — ${evt.reason}` : ''}`;
          }
          case 'meds-worksheet-pending': {
            const agent = labelForProfileKey(evt.agentProfileKey === 'gpt' ? 'gpt' : 'default');
            return `[${t}] Medications Worksheet deferred — ${agent} not ready yet${evt.reason ? ` (${evt.reason})` : ''}`;
          }
          case 'medications-dismissed': return `[${t}] Medications step dismissed without verification`;
          case 'current-medications-recovery-failed': return `[${t}] Current Medications recovery FAILED — fell through ${Array.isArray(evt.pathsTried) ? evt.pathsTried.join(' -> ') : 'all paths'}`;
          case 'medications-saved': {
            const src = evt.source ? ` from ${String(evt.source).replace(/-/g, ' ')}` : '';
            return `[${t}] Current Medications saved (${evt.lines || 0} lines)${src}`;
          }
          case 'medications-restored': return `[${t}] Current Medications restored (${evt.lines || 0} lines)`;
          case 'summary-saved': return `[${t}] Patient Summary saved (${evt.lines || 0} lines, ${Number(evt.chars || 0).toLocaleString()} chars)`;
          case 'summary-verified': return `[${t}] Patient Summary verified (${evt.lines || 0} lines, ${Number(evt.chars || 0).toLocaleString()} chars)`;
          case 'summary-restored': return `[${t}] Patient Summary restored (${evt.lines || 0} lines, ${Number(evt.chars || 0).toLocaleString()} chars)`;
          case 'restore-folder-added': {
            const names = Array.isArray(evt.files) ? evt.files.join(', ') : '';
            const act = evt.action ? ` — ${evt.action}` : '';
            return `[${t}] Folder change: ${evt.count || 0} file(s) added since last sign-off${names ? ': ' + names : ''}${act}`;
          }
          case 'restore-folder-removed': {
            const names = Array.isArray(evt.files) ? evt.files.join(', ') : '';
            const act = evt.action ? ` — ${evt.action}` : '';
            return `[${t}] Folder change: ${evt.count || 0} file(s) removed since last sign-off${names ? ': ' + names : ''}${act}`;
          }
          case 'restore-state-incomplete': {
            const missing = Array.isArray(evt.missing) ? evt.missing.join(', ') : '';
            return `[${t}] maia-state.json is missing: ${missing} — manual entry will be required after restore`;
          }
          case 'restore-path-chosen': {
            const detail = evt.path === 'rehydrate-v2'
              ? 'new full-doc rehydrate path (v2 snapshot)'
              : `legacy per-field path (snapshot v${evt.snapshotSchemaVersion || 1}${evt.hasUserDocInState ? ', has userDoc' : ', no userDoc'})`;
            return `[${t}] Restore path: ${detail}`;
          }
          // maia-state-saved was a diagnostic event; no longer emitted.
          // Keep a no-op renderer so any old events in existing logs
          // don't fall to the default 'unknown' line.
          case 'maia-state-saved': return null as any;
          case 'restore-fallback-to-legacy': {
            return `[${t}] Restore fell back to legacy path: ${evt.reason || 'unknown error'}`;
          }
          case 'restore-postcommit-error': {
            return `[${t}] Restore completed with a post-step warning (account is restored): ${evt.reason || 'unknown'}`;
          }
          case 'chats-restored': return `[${t}] Saved chats restored (${evt.count || 0})`;
          case 'instructions-restored': return `[${t}] Agent Instructions restored`;
          case 'lists-restored': return `[${t}] My Lists restored`;
          case 'test-started': return `[${t}] TEST mode started (automated Setup/Restore run)`;
          case 'test-completed': return `[${t}] TEST mode completed${evt.passed !== undefined ? (evt.passed ? ' — PASS' : ' — FAIL') : ''}`;
          case 'test-verification': return `[${t}] TEST verification: ${evt.label || ''} ${evt.passed ? 'PASS' : 'FAIL'}${evt.detail ? ' - ' + evt.detail : ''}`;
          case 'admin-notified': return `[${t}] Admin notified — from: ${evt.from || '?'}, to: ${evt.to || '?'}`;
          case 'preparation-phase-started': return `[${t}] Preparation phase started (deploy secondary agent, draft Patient Summary, medication worksheets)`;
          case 'secondary-provision-started': return `[${t}] Deploying ${labelForProfileKey('gpt')} agent...`;
          case 'secondary-provision-ready': return `[${t}] ${labelForProfileKey('gpt')} agent ready${evt.elapsedSeconds ? ` (${evt.elapsedSeconds}s)` : ''}`;
          case 'secondary-provision-timeout': return `[${t}] ${labelForProfileKey('gpt')} agent deployment timed out${evt.elapsedSeconds ? ` after ${evt.elapsedSeconds}s` : ''}`;
          case 'secondary-provision-failed': return `[${t}] ${labelForProfileKey('gpt')} agent deployment failed${evt.error ? `: ${evt.error}` : ''}`;
          case 'secondary-deploy-step': return `[${t}]   ${evt.step}${evt.ok === false && evt.error ? ` — ${evt.error}` : ''}${evt.elapsed ? ` (${evt.elapsed}s)` : ''}`;
          case 'gpt-provision-poll-started': return null as any;
          case 'gpt-provision-poll-ready': return null as any;
          case 'gpt-provision-poll-timeout': return null as any;
          case 'draft-summary-call-started': return `[${t}] Starting draft Patient Summary generation...`;
          case 'draft-summary-started': return null as any;
          case 'draft-summary-kb-attached': return null as any;
          case 'draft-summary-ah-lists': return null as any;
          case 'draft-summary-prompt-built': return null as any;
          case 'draft-summary-primary-failed': return `[${t}] Draft Patient Summary — ${labelForProfileKey('default')} failed${evt.error ? `: ${evt.error}` : ''}`;
          case 'draft-summary-primary-key-recreated': return `[${t}] Draft Patient Summary — API key recreated, retrying ${labelForProfileKey('default')}`;
          case 'draft-summary-primary-retry-failed': return `[${t}] Draft Patient Summary — ${labelForProfileKey('default')} retry failed`;
          case 'draft-summary-fallback-started': return `[${t}] Draft Patient Summary — falling back to ${labelForProfileKey('gpt')}`;
          case 'draft-summary-fallback-succeeded': return `[${t}] Draft Patient Summary — ${labelForProfileKey('gpt')} succeeded`;
          case 'draft-summary-fallback-failed': return `[${t}] Draft Patient Summary — ${labelForProfileKey('gpt')} fallback FAILED`;
          case 'draft-summary-succeeded': return null as any;
          case 'medication-worksheets-started': return `[${t}] Generating medication worksheets...`;
          case 'medications-phase-opened': return `[${t}] Medications ready for verification`;
          case 'medications-verified': return `[${t}] Current Medications verified by user`;
          case 'no-draft-ps-available': return `[${t}] No provisional Patient Summary available to patch with verified medications`;
          case 'workbook-opened': return `[${t}] Workbook opened`;
          case 'workbook-dismissed': return `[${t}] Workbook dismissed`;
          case 'workbook-tab': return `[${t}]   Tab: ${evt.tab || 'unknown'}`;
          case 'chat-question': return `[${t}] Chat question for ${evt.provider || 'unknown'}`;
          case 'chat-response': {
            const dur = evt.seconds > 2 ? ` (${evt.seconds}s)` : '';
            return `[${t}]   Response: ${evt.lines || 0} lines${dur}`;
          }
          case 'chat-saved': return `[${t}] Chat saved to ${evt.destination || 'unknown'}`;
          case 'file-added': return `[${t}] File added: ${evt.fileName || 'unknown'}`;
          case 'sign-out-requested': return `[${t}] Sign out requested`;
          case 'chat-error': return `[${t}] Chat ERROR: ${evt.provider || 'unknown'} — ${evt.error || 'unknown error'}`;
          case 'error': return `[${t}] ERROR: ${evt.step || ''} - ${evt.message || ''}`;
          case 'patient-identity-extraction-failed':
            // Bold red — appears in the log when the PS builder
            // couldn't parse Name/DOB/Sex from any KB file. The PS
            // prompt is also told NOT to guess (see server/index.js
            // buildPatientSummaryPromptForUser).
            return `[${t}] SAFETY: Patient identity could not be parsed from any file${evt.context ? ` [${evt.context}]` : ''}.\n        ${evt.reason || ''}\n        The Patient Summary will say "Patient name not parseable from records" instead of guessing.`;
          case 'patient-consistency-mismatch': {
            // Bolded by the isMilestone check below (event ends with
            // a '-mismatch' suffix → matched as a milestone). The
            // body line is INTENTIONALLY verbose so a clinician /
            // support person reading the PDF sees exactly what was
            // detected and which files were involved.
            const ctx = evt.context ? ` [${evt.context}]` : '';
            const mismatches = Array.isArray(evt.mismatchFiles) && evt.mismatchFiles.length
              ? `\n        Mismatch files: ${evt.mismatchFiles.join(', ')}`
              : '';
            return `[${t}] SAFETY: Patient mismatch detected${ctx}\n        Primary: ${evt.primary || '(unknown)'} (DOB ${evt.primaryDob || 'unknown'})${mismatches}\n        Reason: ${evt.reason || ''}`;
          }
          default: return `[${t}] ${evt.event || 'unknown'}`;
        }
      };

      // Render session boundaries and events
      let lastSession = '';
      for (let i = 0; i < events.length; i++) {
        const evt = events[i];
        // Draw session divider for start events
        if (evt.event === 'setup-started' || evt.event === 'restore-started') {
          let isTest = !!evt.test;
          if (!isTest) {
            // Look ahead within this section for a test-started event before the next section boundary
            for (let j = i + 1; j < events.length; j++) {
              const nx = events[j].event;
              if (nx === 'setup-started' || nx === 'restore-started' || nx === 'account-deleted') break;
              if (nx === 'test-started') { isTest = true; break; }
            }
          }
          const testTag = isTest ? ' (TEST)' : '';
          // Time-stamped section heading. We fold "[time] Setup started" /
          // "[time] Restore started" INTO the divider so the bold section
          // label itself unambiguously announces the start — matches the
          // visual weight of the later "Setup complete" / "Restore
          // complete" milestones.
          const startTime = evt.time ? new Date(evt.time).toLocaleTimeString() : '??:??';
          const action = evt.event === 'setup-started' ? 'Setup started' : 'Restore started';
          const label = `--- ${action} @ ${startTime}${testTag} ---`;
          if (lastSession) {
            y += 3;
            doc.setDrawColor(100);
            doc.line(margin, y, pageWidth - margin, y);
            y += 6;
          }
          lastSession = evt.event;
          doc.setFontSize(10);
          doc.setFont('helvetica', 'bold');
          doc.text(label, margin, y);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          y += 6;
          // Skip the separate "[time] Setup started" / "[time] Restore
          // started" event line — already represented in the bold header.
          continue;
        } else if (evt.event === 'account-deleted' && lastSession) {
          y += 3;
          doc.setDrawColor(100);
          doc.line(margin, y, pageWidth - margin, y);
          y += 6;
        }

        if (y > 270) { doc.addPage(); y = 20; }

        const [r, g, b] = getEventColor(evt);
        const text = formatEvent(evt);
        // A null/empty render means "intentionally not shown" (diagnostic
        // events we keep a renderer for but don't want in the PDF).
        if (!text) continue;
        const isMilestone = evt.event === 'setup-complete' || evt.event === 'restore-complete'
          || evt.event === 'account-deleted' || evt.event === 'patient-consistency-mismatch'
          || evt.event === 'patient-identity-extraction-failed';

        if (isMilestone) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(10);
        }
        doc.setTextColor(r, g, b);
        const splitLines = doc.splitTextToSize(text, maxWidth);
        for (const sl of splitLines) {
          if (y > 270) { doc.addPage(); y = 20; }
          doc.text(sl, margin, y);
          y += isMilestone ? 6 : 5;
        }
        doc.setTextColor(0, 0, 0);
        if (isMilestone) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          y += 2;
        }

        // Render email body block for admin-notified events
        if (evt.event === 'admin-notified' && evt.body) {
          const bodyIndent = margin + 8;
          const bodyMaxWidth = maxWidth - 8;
          doc.setFontSize(8);
          doc.setTextColor(80, 80, 80);
          // Draw a light background box
          const bodyLines = doc.splitTextToSize(evt.body, bodyMaxWidth);
          const blockHeight = bodyLines.length * 4 + 4;
          if (y + blockHeight > 270) { doc.addPage(); y = 20; }
          doc.setFillColor(245, 245, 245);
          doc.roundedRect(margin + 4, y - 3, maxWidth - 4, blockHeight, 1, 1, 'F');
          y += 1;
          for (const bl of bodyLines) {
            if (y > 270) { doc.addPage(); y = 20; }
            doc.text(bl, bodyIndent, y);
            y += 4;
          }
          y += 3;
          doc.setTextColor(0, 0, 0);
          doc.setFontSize(9);
        }
      }

    } else {
      doc.text('No provisioning events recorded.', margin, y);
      y += 6;
    }
  } catch (err) {
    doc.text('Error loading provisioning log.', margin, y);
    y += 6;
  }

  // (Removed v1.4.5: the "How the My Lists tab works" static explainer
  // page used to live here. It duplicated Documentation/Clinical.md and
  // made the log harder to scan; the log should be operational events
  // only, not reference docs. If you want the explainer, read
  // Documentation/Clinical.md §1 directly.)

  const pdfBlob = doc.output('blob');
  await writeFileToFolder(localFolderHandle.value, 'maia-log.pdf', pdfBlob);
  // Clean up legacy filename
  try { await localFolderHandle.value.removeEntry('maia-setup-log.pdf'); } catch { /* doesn't exist */ }
  // NOTE: state persistence is intentionally DECOUPLED from log-PDF
  // generation. generateSetupLogPdf is called on every wizard event
  // (~12×/cycle) and during sign-out/destroy when the session is
  // already gone. Previously it also called saveStateToLocalFolder,
  // which fired a 7-endpoint re-save each time — flooding the console
  // with 401/404s during session transitions and risking a v1
  // clobber. maia-state.json is now written ONLY by App.vue's
  // saveLocalSnapshot at the meaningful persistence points (sign-out,
  // destroy-before-delete, wizard-complete, restore-complete) and by
  // runAutoWizard's explicit Phase-5 call. The PDF here is rendered
  // from the in-memory provisioning events; it needs no network.
};

// Coalesce back-to-back saveStateToLocalFolder calls. generateSetupLogPdf
// invokes this and is itself called by half a dozen watchers during a
// normal Setup cycle (file uploaded, file moved to KB, indexing progress,
// medications saved, summary saved, etc.). Without a guard we get 10–15
// duplicate writes per cycle, each fetching /api/user-doc/full and
// scanning the folder. We trail-debounce: if a write is already in
// flight, queue ONE follow-up write after it lands; further calls
// during the in-flight window are folded into that single follow-up.
let saveStateInFlight = false;
let saveStatePending = false;
let saveStateLastDoneAt = 0;
let saveStateTrailingTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_STATE_MIN_INTERVAL_MS = 4000;

/** Save current app state to maia-state.json in the local folder.
 *  Throttled: at most one write per SAVE_STATE_MIN_INTERVAL_MS. Calls
 *  during the cooldown schedule a single trailing write so the final
 *  state always lands. generateSetupLogPdf (the only caller) fires from
 *  ~6 watchers during a Setup cycle; without this we get 15+ writes,
 *  each fetching /api/user-doc/full + scanning the folder. */
const saveStateToLocalFolder = async () => {
  if (!localFolderHandle.value || !props.user?.userId) return;
  const sinceLast = Date.now() - saveStateLastDoneAt;
  if (saveStateInFlight || sinceLast < SAVE_STATE_MIN_INTERVAL_MS) {
    // Schedule (or reschedule) a single trailing write.
    if (saveStateTrailingTimer) clearTimeout(saveStateTrailingTimer);
    const delay = saveStateInFlight
      ? SAVE_STATE_MIN_INTERVAL_MS
      : Math.max(0, SAVE_STATE_MIN_INTERVAL_MS - sinceLast);
    saveStateTrailingTimer = setTimeout(() => {
      saveStateTrailingTimer = null;
      void saveStateToLocalFolder();
    }, delay);
    saveStatePending = true;
    return;
  }
  saveStateInFlight = true;
  try {
    await saveStateToLocalFolderImpl();
  } finally {
    saveStateInFlight = false;
    saveStateLastDoneAt = Date.now();
    if (saveStatePending && !saveStateTrailingTimer) {
      saveStatePending = false;
      saveStateTrailingTimer = setTimeout(() => {
        saveStateTrailingTimer = null;
        void saveStateToLocalFolder();
      }, SAVE_STATE_MIN_INTERVAL_MS);
    }
  }
};

const saveStateToLocalFolderImpl = async () => {
  if (!localFolderHandle.value || !props.user?.userId) return;
  const userId = props.user.userId;

  // Fetch actual content from server for each field, defaulting to null on error
  let medicationsText: string | null = null;
  let summaryText: string | null = null;
  let savedChatsData: any = undefined;
  let agentInstructionsText: string | null = null;
  let listsMarkdownText: string | null = null;
  let provisioningLogData: Array<Record<string, any>> | undefined = undefined;
  // Phase 1 of the local-first redesign: ALSO fetch the full userDoc so
  // this writer produces a v2 snapshot. Without this, every call to
  // saveStateToLocalFolder clobbered App.vue's saveLocalSnapshot v2
  // write back to a v1 shape — the second writer that we missed when
  // upgrading the schema. See Documentation/NewRestore.md.
  let fullUserDoc: Record<string, any> | null = null;

  const fetchOpts = { credentials: 'include' as RequestCredentials };

  await Promise.allSettled([
    (async () => {
      try {
        const res = await fetch(`/api/user-status?userId=${encodeURIComponent(userId)}`, fetchOpts);
        if (res.ok) {
          const data = await res.json();
          if (data.currentMedications) medicationsText = data.currentMedications;
        }
      } catch { /* default to null */ }
    })(),
    (async () => {
      try {
        const res = await fetch(`/api/patient-summary?userId=${encodeURIComponent(userId)}`, fetchOpts);
        if (res.ok) {
          const data = await res.json();
          if (data.summary) summaryText = data.summary;
        }
      } catch { /* default to null */ }
    })(),
    (async () => {
      try {
        const res = await fetch(`/api/shared-group-chats?userId=${encodeURIComponent(userId)}`, fetchOpts);
        if (res.ok) {
          const data = await res.json();
          if (data.chats) savedChatsData = data.chats;
        }
      } catch { /* default to undefined */ }
    })(),
    (async () => {
      try {
        const res = await fetch(`/api/agent-instructions?userId=${encodeURIComponent(userId)}`, fetchOpts);
        if (res.ok) {
          const data = await res.json();
          if (data.instructions) agentInstructionsText = data.instructions;
        }
      } catch { /* default to null */ }
    })(),
    (async () => {
      try {
        const res = await fetch(`/api/files/lists/markdown?userId=${encodeURIComponent(userId)}`, fetchOpts);
        if (res.ok) {
          const data = await res.json();
          if (data.markdown) listsMarkdownText = data.markdown;
        }
      } catch { /* default to null */ }
    })(),
    (async () => {
      try {
        // Fetch current server events
        const res = await fetch(`/api/provisioning-log?userId=${encodeURIComponent(userId)}`, fetchOpts);
        let serverLog: Array<Record<string, any>> = [];
        if (res.ok) {
          const data = await res.json();
          if (data.log && Array.isArray(data.log)) serverLog = data.log;
        }
        // Read existing local events to preserve history across account deletion/recreation
        let existingLocal: Array<Record<string, any>> = [];
        if (localFolderHandle.value) {
          try {
            const existingState = await readStateFile(localFolderHandle.value);
            if (existingState?.provisioningLog && Array.isArray(existingState.provisioningLog)) {
              existingLocal = existingState.provisioningLog;
            }
          } catch { /* no existing state */ }
        }
        // Merge: keep all existing local events, add server events not already present
        const evtKey = (e: Record<string, any>) => `${e.id ?? ''}-${e.time ?? ''}`;
        const localKeys = new Set(existingLocal.map(evtKey));
        const newFromServer = serverLog.filter(e => !localKeys.has(evtKey(e)));
        const merged = [...existingLocal, ...newFromServer].sort((a, b) =>
          (a.time || '').localeCompare(b.time || '')
        );
        if (merged.length > 0) provisioningLogData = merged;
      } catch { /* default to undefined */ }
    })(),
    (async () => {
      try {
        const res = await fetch('/api/user-doc/full', fetchOpts);
        if (res.ok) {
          const data = await res.json();
          if (data?.userDoc) fullUserDoc = data.userDoc;
        }
      } catch { /* fall back to existing below */ }
    })()
  ]);

  // INVARIANT: never downgrade the backup. This writer is invoked by
  // generateSetupLogPdf, which App.vue calls during sign-out / cloud
  // destroy — by then the session is gone and /api/user-doc/full 401s.
  // If the fresh fetch failed, reuse the userDoc already on disk so a
  // transient auth failure can't turn a good v2 backup into a v1 one.
  if (!fullUserDoc) {
    try {
      const existingState = await readStateFile(localFolderHandle.value);
      if (existingState?.userDoc) {
        fullUserDoc = existingState.userDoc;
        console.warn('[saveState] userDoc fetch failed — preserving existing v2 backup (no downgrade)');
      }
    } catch { /* no existing state; will write v1 (first run only) */ }
  }

  // Folder inventory (only PDFs / structured records — exclude MAIA-
  // generated files). Used by Restore to diff against userDoc.files.
  let folderInventory: Array<{ name: string; size?: number; mtime?: number }> = [];
  try {
    const { listFolderFiles } = await import('../utils/localFolder');
    const folderEntries = await listFolderFiles(localFolderHandle.value);
    folderInventory = folderEntries
      .filter(f => {
        const n = f.name.toLowerCase();
        return n !== 'maia-log.pdf' && n !== 'maia-state.json' && !n.endsWith('.webloc');
      })
      .map(f => ({ name: f.name, size: f.size, mtime: f.lastModified }));
  } catch { /* default to empty */ }

  const state: MaiaState = {
    // ── v2 fields (the actual backup) ─────────────────────────
    schemaVersion: fullUserDoc ? 2 : 1,
    userDoc: fullUserDoc || undefined,
    folder: { files: folderInventory },
    // ── v1 legacy fields (kept for one release for back-compat) ─
    version: 2,
    userId: userId,
    displayName: props.user.displayName,
    updatedAt: new Date().toISOString(),
    files: wizardStage3Files.value.map(f => ({
      fileName: f.name,
      cloudStatus: f.inKnowledgeBase ? 'indexed' as const : 'pending' as const,
      bucketKey: f.bucketKey,
      ...(f.isAppleHealth ? { isAppleHealth: true } : {})
    })),
    currentMedications: medicationsText,
    patientSummary: summaryText,
    savedChats: savedChatsData ? { chats: savedChatsData } : undefined,
    currentChat: undefined,
    agentInstructions: agentInstructionsText,
    listsMarkdown: listsMarkdownText,
    provisioningLog: provisioningLogData
  };
  await writeStateFile(localFolderHandle.value, state);
};

const stage3IndexingPoll = ref<ReturnType<typeof setInterval> | null>(null);
const stage3IndexingPending = ref(false);
const stage3IndexingStartedAt = ref<number | null>(null);
const stage3IndexingCompletedAt = ref<number | null>(null);
// Number of files we expect to be indexed in the current job. Used to gate the
// 7-minute tokenTimeout safety net so it doesn't fire while DO is still working
// through the remaining files (DO's `indexed_file_count` increments as each
// file finishes; without this check the wizard reports e.g. "1 of 4" indexed).
const stage3ExpectedFileCount = ref<number>(0);
const stage3ElapsedTick = ref(0);
let stage3ElapsedTimer: ReturnType<typeof setInterval> | null = null;
const formatElapsed = (start: number | null, end?: number | null) => {
  if (!start) return '';
  void stage3ElapsedTick.value;
  const elapsedMs = (end || Date.now()) - start;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
};
const startStage3ElapsedTimer = () => {
  if (stage3ElapsedTimer) return;
  stage3ElapsedTimer = setInterval(() => {
    stage3ElapsedTick.value += 1;
  }, 1000);
};
const stopStage3ElapsedTimer = () => {
  if (stage3ElapsedTimer) {
    clearInterval(stage3ElapsedTimer);
    stage3ElapsedTimer = null;
  }
};

const handleStage3Index = async (overrideNames?: string[], fromRestore = false) => {
  const userId = props.user?.userId;
  if (!userId) return;
  if (stage3IndexingActive.value) return;
  stage3IndexingPending.value = true;
  // Record the expected file count for the tokenTimeout safety-net check below.
  // Use the override list when provided (that's what we just toggled to KB).
  stage3ExpectedFileCount.value = Array.isArray(overrideNames) && overrideNames.length > 0
    ? overrideNames.length
    : wizardStage3Files.value.length;
  if (fromRestore) {
    restoreIndexingActive.value = true;
  }
  try {
    const stage3Names = (overrideNames && overrideNames.length > 0)
      ? overrideNames
      : Array.from(new Set(wizardStage3Files.value.map(file => file.name)));
    if (stage3Names.length > 0) {
      const fetchWizardFiles = async () => {
        const filesResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(userId)}&source=wizard`, {
          credentials: 'include'
        });
        if (!filesResponse.ok) return [];
        const filesResult = await filesResponse.json();
        return Array.isArray(filesResult?.files) ? filesResult.files : [];
      };

      let files = await fetchWizardFiles();
      let byName = new Map<string, any>();
      for (const file of files) {
        const name = getFileNameFromEntry(file);
        if (!name || byName.has(name)) continue;
        byName.set(name, file);
      }

      let missingTargets: string[] = [];
      for (const name of stage3Names) {
        const file = byName.get(name);
        const bucketKey = file?.bucketKey;
        if (!bucketKey) {
          missingTargets.push(name);
        }
      }

      if (missingTargets.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 200));
        files = await fetchWizardFiles();
        byName = new Map();
        for (const file of files) {
          const name = getFileNameFromEntry(file);
          if (!name || byName.has(name)) continue;
          byName.set(name, file);
        }
        missingTargets = [];
        for (const name of stage3Names) {
          const file = byName.get(name);
          const bucketKey = file?.bucketKey;
          if (!bucketKey) {
            missingTargets.push(name);
          }
        }
      }

      if (missingTargets.length > 0) {
        throw new Error(`Missing bucket keys for: ${missingTargets.join(', ')}`);
      }

      const movedToKbBucketKeys: string[] = [];
      const toggleFailures: Array<{ name: string; status: number; error?: string }> = [];
      let alreadyInKB = 0;
      for (const name of stage3Names) {
        const file = byName.get(name);
        const bucketKey = file?.bucketKey;
        if (!bucketKey) continue;
        if (file?.inKnowledgeBase) {
          alreadyInKB++;
          continue;
        }
        const toggleResponse = await fetch('/api/toggle-file-knowledge-base', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.user.userId,
            bucketKey,
            inKnowledgeBase: true
          })
        });
        if (!toggleResponse.ok) {
          const errorData = await toggleResponse.json().catch(() => ({}));
          const msg = errorData.message || errorData.error || `HTTP ${toggleResponse.status}`;
          toggleFailures.push({ name, status: toggleResponse.status, error: msg });
          // Don't throw — keep going so as many files as possible end up in KB.
          continue;
        }
        movedToKbBucketKeys.push(bucketKey);
      }
      if (toggleFailures.length > 0) {
        console.warn('[handleStage3Index] Toggle failures:', toggleFailures);
      }
      if (movedToKbBucketKeys.length > 0) {
        handleFilesArchived(movedToKbBucketKeys);
      }

      const verifyResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(props.user.userId)}`, {
        credentials: 'include'
      });
      if (verifyResponse.ok) {
        const verifyResult = await verifyResponse.json();
        const kbFiles = Array.isArray(verifyResult?.files)
          ? verifyResult.files.filter((file: { inKnowledgeBase?: boolean }) => !!file.inKnowledgeBase)
          : [];
        if (kbFiles.length === 0) {
          throw new Error('No KB files found after moving imports.');
        }
      }
    }

    const response = await fetch('/api/update-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.user.userId
      })
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Failed to update knowledge base: ${response.status}`);
    }
    const result = await response.json();
    stage3LastImportedName.value = null;
    stage3IndexingStartedAt.value = Date.now();
    stage3IndexingCompletedAt.value = null;
    try {
      const k = wizardStage3IndexingStartedKey(props.user?.userId);
      if (k) sessionStorage.setItem(k, String(stage3IndexingStartedAt.value));
    } catch { /* ignore */ }
    indexingStatus.value = {
      active: true,
      phase: 'indexing',
      tokens: '0',
      filesIndexed: 0,
      progress: 0
    };
    startStage3ElapsedTimer();
    stage3IndexingPending.value = false;
    if (stage3IndexingPoll.value) {
      clearInterval(stage3IndexingPoll.value);
    }
    if (result?.jobId) {
      if (fromRestore) {
        const files = Array.isArray(props.rehydrationFiles) ? props.rehydrationFiles : [];
        const hasInitialFile = files.some((item: { isInitial?: boolean }) => !!item?.isInitial);
        emit('rehydration-complete', { hasInitialFile });
      }
      stage3IndexingPoll.value = setInterval(async () => {
        try {
          const statusResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(props.user?.userId || '')}&source=wizard`, {
            credentials: 'include'
          });
          if (!statusResponse.ok) {
            throw new Error(`Indexing status error: ${statusResponse.status}`);
          }
          const statusResult = await statusResponse.json();
          const kbStatus = statusResult.kbIndexingStatus || {};
          const liveActive = !!statusResult?.kbIndexingActive;
          const backendDone = kbStatus.backendCompleted === true;
          // Fix: '0' is truthy in JS, so use Number() to properly fall through to kbTotalTokens
          const storedTokens = kbStatus.tokens;
          const liveTokens = statusResult?.kbTotalTokens ? String(statusResult.kbTotalTokens) : '0';
          const tokens = (Number(storedTokens) > 0) ? storedTokens : liveTokens;
          const elapsedPollMs = stage3IndexingStartedAt.value ? Date.now() - stage3IndexingStartedAt.value : 0;
          // (Verbose per-poll state log + human-readable elapsed
          // formatter removed. Terminal completion no longer
          // logs to console either — the maia-log
          // logProvisioningEvent 'kb-indexed' entry captures the
          // completion for the log file.)
          if (indexingStatus.value) {
            indexingStatus.value.phase = kbStatus.phase || indexingStatus.value.phase;
            indexingStatus.value.tokens = tokens;
            indexingStatus.value.filesIndexed = kbStatus.filesIndexed || 0;
            indexingStatus.value.progress = kbStatus.progress || 0;
          }
          // Log progress every ~60s (every 6th poll at 10s interval)
          if (elapsedPollMs > 0 && Math.floor(elapsedPollMs / 60000) !== Math.floor((elapsedPollMs - 10000) / 60000)) {
          }
          // Trust backendCompleted; also infer completion if DO API says not active and tokens > 0
          const inferredComplete = !liveActive && Number(tokens) > 0;
          // Also complete if DO API says not active for > 5 minutes (handles 0-token edge case)
          const timedOutInactive = !liveActive && !backendDone && elapsedPollMs > 5 * 60 * 1000;
          // Client-side safety net: if tokens > 0 for > 7 minutes AND DO has indexed every
          // expected file, complete even if liveActive is true (DO's job status can lag
          // indefinitely behind actual completion). Without the file-count gate, this
          // fires while DO is still working through the remaining files and the wizard
          // reports e.g. "1 of 4 indexed".
          const filesIndexedSoFar = Number(kbStatus.filesIndexed) || 0;
          const allExpectedFilesIndexed = stage3ExpectedFileCount.value > 0
            ? filesIndexedSoFar >= stage3ExpectedFileCount.value
            : filesIndexedSoFar > 0;
          const tokenTimeoutComplete = !backendDone && !inferredComplete && Number(tokens) > 0 && elapsedPollMs > 7 * 60 * 1000 && allExpectedFilesIndexed;
          // Pure time-based fallback: 30+ minutes with no completion signal at all (handles
          // 0-token "no changes" or DO API stuck). Raised from 20 → 30 min because some
          // KBs of 4–10 PDFs legitimately take 15–25 minutes to index.
          const pureTimeoutComplete = !backendDone && !inferredComplete && !tokenTimeoutComplete && elapsedPollMs > 30 * 60 * 1000;
          const isCompleted = backendDone || inferredComplete || timedOutInactive || tokenTimeoutComplete || pureTimeoutComplete;
          if (isCompleted) {
            logProvisioningEvent({
              event: 'kb-indexed',
              tokens: parseInt(tokens) || 0,
              fileCount: parseInt(String(kbStatus.filesIndexed)) || 0,
              elapsedMs: elapsedPollMs || null
            });
            if (stage3IndexingPoll.value) {
              clearInterval(stage3IndexingPoll.value);
              stage3IndexingPoll.value = null;
            }
            if (indexingStatus.value) {
              indexingStatus.value.active = false;
              indexingStatus.value.phase = 'complete';
            }
            stage3IndexingCompletedAt.value = Date.now();
            stopStage3ElapsedTimer();
            try {
              const k = wizardStage3IndexingStartedKey(props.user?.userId);
              if (k) sessionStorage.removeItem(k);
            } catch { /* ignore */ }
            await refreshWizardState();
            if (restoreIndexingActive.value) {
              restoreIndexingActive.value = false;
              showRestoreCompleteDialog.value = true;
            }
          }
        } catch (pollError) {
          console.warn('[KB-POLL] Error:', pollError);
        }
      }, 10000);
    }
  } catch (error) {
    console.warn('Failed to start indexing from wizard:', error);
    const message = error instanceof Error ? error.message : 'Failed to start indexing';
    alert(message);
    restoreIndexingActive.value = false;
    stage3IndexingPending.value = false;
  }
};



const handleFileSelect = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];

  if (!file) return;

  // Reconnect local folder NOW while we still have user-gesture context
  // (requestPermission requires an active gesture; it'll be lost after the first await)
  if (!localFolderHandle.value && props.user?.userId) {
    try {
      const result = await reconnectLocalFolderWithGesture(props.user.userId);
      if (result) {
        localFolderHandle.value = result.handle;
        localFolderName.value = result.folderName;
      }
    } catch (e) {
      // Not critical — file will still upload to cloud
    }
  }

  if (wizardUploadIntent.value === 'restore') {
    isUploadingFile.value = true;
    try {
      await uploadRestoreFile(file);
    } catch (error) {
      console.error('Error restoring file:', error);
      alert(`Error restoring file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      isUploadingFile.value = false;
      wizardUploadIntent.value = null;
      wizardRestoreTargetName.value = null;
    }
    return;
  }

  if (wizardUploadIntent.value === 'other') {
    stage3PendingUploadName.value = file.name;
    try {
      const pendingKey = props.user?.userId ? `wizardKbPendingFileName-${props.user.userId}` : 'wizardKbPendingFileName';
      localStorage.setItem(pendingKey, file.name);
      logWizardEvent('stage3_pending_file_set', { fileName: file.name });
    } catch (error) {
      // ignore storage errors
    }
  }

  isUploadingFile.value = true;

  try {
    // Detect file type
    const fileType = detectFileType(file.name, file.type);
    
    if (fileType === 'pdf') {
      await uploadPDFFile(file);
    } else if (fileType === 'text' || fileType === 'markdown') {
      await uploadTextFile(file);
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Error uploading file:', error);
    alert(`Error uploading file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    stage3PendingUploadName.value = null;
  } finally {
    isUploadingFile.value = false;
    if (wizardUploadIntent.value) {
      handleWizardFileSelect();
    }
  }
};

const detectFileType = (fileName: string, mimeType: string): 'text' | 'pdf' | 'markdown' => {
  const ext = fileName.toLowerCase().split('.').pop();
  
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    return 'pdf';
  }
  
  if (ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }
  
  return 'text';
};

// Helper to detect file type from stored file metadata
const detectFileTypeFromMetadata = (fileName: string, fileType?: string): 'text' | 'pdf' | 'markdown' => {
  // If fileType is already set and valid, use it
  if (fileType === 'pdf' || fileType === 'text' || fileType === 'markdown') {
    return fileType;
  }
  
  // Otherwise, detect from filename
  return detectFileType(fileName, '');
};

const detectAppleHealthFromBucket = async (bucketKey: string): Promise<boolean> => {
  if (!bucketKey) return false;
  try {
    const parseResponse = await fetch(`/api/files/parse-pdf-first-page/${encodeURIComponent(bucketKey)}`, {
      method: 'GET',
      credentials: 'include'
    });
    if (!parseResponse.ok) return false;
    const parseResult = await parseResponse.json();
    const pageText = String(parseResult?.firstPageText || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    return pageText.includes(appleExportFooterNormalized);
  } catch (error) {
    return false;
  }
};

const findRehydrationEntry = (fileName: string) => {
  if (!fileName) return null;
  const files = Array.isArray(props.rehydrationFiles) ? props.rehydrationFiles : [];
  return files.find(entry => {
    const entryName = entry?.fileName || (entry?.bucketKey ? entry.bucketKey.split('/').pop() : null);
    return entryName === fileName;
  }) || null;
};

const uploadRestoreFile = async (file: File) => {
  if (!props.user?.userId) return;
  const targetName = wizardRestoreTargetName.value || file.name;
  const entry = findRehydrationEntry(targetName);
  if (!entry) {
    throw new Error(`Restore entry not found for ${targetName}`);
  }
  if (file.name !== targetName) {
    throw new Error(`Please select the file named "${targetName}".`);
  }

  const formData = new FormData();
  formData.append('file', file);
  const uploadResponse = await fetch('/api/files/upload', {
    method: 'POST',
    credentials: 'include',
    body: formData
  });
  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json().catch(() => ({}));
    throw new Error(errorData.message || errorData.error || 'Failed to upload file');
  }
  const uploadResult = await uploadResponse.json();

  await fetch('/api/user-file-metadata', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      userId: props.user.userId,
      fileMetadata: {
        fileName: uploadResult.fileInfo.fileName,
        bucketKey: uploadResult.fileInfo.bucketKey,
        bucketPath: uploadResult.fileInfo.userFolder,
        fileSize: uploadResult.fileInfo.size,
        fileType: uploadResult.fileInfo.mimeType,
        uploadedAt: uploadResult.fileInfo.uploadedAt
      },
      updateInitialFile: !!entry?.isInitial
    })
  });

  emit('rehydration-file-removed', {
    fileName: targetName,
    bucketKey: entry?.bucketKey
  });
};

const uploadPDFFile = async (file: File) => {
  // Check file size
  const maxSize = 50 * 1024 * 1024; // 50MB
  if (file.size > maxSize) {
    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 50MB.`);
  }

  // Parse PDF on server
  const formData = new FormData();
  formData.append('pdfFile', file);
  
  const parseResponse = await fetch('/api/files/parse-pdf', {
    method: 'POST',
    credentials: 'include',
    body: formData
  });

  if (!parseResponse.ok) {
    const errorData = await parseResponse.json();
    throw new Error(errorData.error || 'Failed to parse PDF');
  }

  const parseResult = await parseResponse.json();
  

  // Upload to bucket
  const uploadFormData = new FormData();
  uploadFormData.append('file', file);
  const uploadResponse = await fetch('/api/files/upload', {
    method: 'POST',
    credentials: 'include',
    body: uploadFormData
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    // Use detailed message if available (e.g., storage limit exceeded)
    throw new Error(errorData.message || errorData.error || 'Failed to upload file');
  }

  const uploadResult = await uploadResponse.json();

  // Update user document with file metadata
  if (props.user?.userId) {
    try {
      const isAppleHealth = await detectAppleHealthFromBucket(uploadResult.fileInfo.bucketKey);
      await fetch('/api/user-file-metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.user.userId,
          fileMetadata: {
            fileName: uploadResult.fileInfo.fileName,
            bucketKey: uploadResult.fileInfo.bucketKey,
            bucketPath: uploadResult.fileInfo.userFolder,
            fileSize: uploadResult.fileInfo.size,
            fileType: 'pdf',
            uploadedAt: uploadResult.fileInfo.uploadedAt,
            isAppleHealth: isAppleHealth
          },
          updateInitialFile: false
        })
      });
      await refreshWizardState();

      // Copy file to local MAIA folder so it's available for offline restore
      // (localFolderHandle was reconnected at file-select time while gesture was active)
      if (localFolderHandle.value) {
        try {
          await writeFileToFolder(localFolderHandle.value, file.name, file);
          // Update maia-state.json to include the new file
          const state = await readStateFile(localFolderHandle.value);
          if (state) {
            const stateFiles = state.files || [];
            const existing = stateFiles.find((f: any) => f.fileName === file.name);
            if (!existing) {
              stateFiles.push({
                fileName: file.name,
                size: file.size,
                cloudStatus: 'uploaded' as const,
                bucketKey: uploadResult.fileInfo.bucketKey
              });
              state.files = stateFiles;
              await writeStateFile(localFolderHandle.value, state);
            }
          }
        } catch (folderErr) {
          console.warn('[localFolder] Failed to copy paperclip file to local folder:', folderErr);
        }
      }
    } catch (error) {
      console.warn('Failed to save file metadata to user document:', error);
    }
  }

  // Create uploaded file object
  const uploadedFile: UploadedFile = {
    id: `file-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    name: file.name,
    size: file.size,
    type: 'pdf',
    content: parseResult.text,
    originalFile: file,
    bucketKey: uploadResult.fileInfo.bucketKey,
    bucketPath: uploadResult.fileInfo.userFolder,
    fileUrl: uploadResult.fileInfo.fileUrl,
    uploadedAt: new Date()
  };

  if (wizardUploadIntent.value === 'other') {
    const importedName = uploadResult.fileInfo.fileName || file.name;
    stage3PendingUploadName.value = null;
    stage3LastImportedName.value = importedName;
    uploadedFiles.value.push(uploadedFile);
    // no-op
  } else if (!wizardUploadIntent.value) {
    uploadedFiles.value.push(uploadedFile);
  }
};

const uploadTextFile = async (file: File) => {
  // Check file size
  const maxSize = 50 * 1024 * 1024; // 50MB
  if (file.size > maxSize) {
    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 50MB.`);
  }

  // Read text content
  const text = await readFileAsText(file);
  
  // Upload to bucket
  const uploadFormData = new FormData();
  uploadFormData.append('file', file);

  const uploadResponse = await fetch('/api/files/upload', {
    method: 'POST',
    credentials: 'include',
    body: uploadFormData
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    throw new Error(errorData.message || errorData.error || 'Failed to upload file');
  }

  const uploadResult = await uploadResponse.json();

  // Update user document with file metadata
  if (props.user?.userId) {
    try {
      await fetch('/api/user-file-metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.user.userId,
          fileMetadata: {
            fileName: uploadResult.fileInfo.fileName,
            bucketKey: uploadResult.fileInfo.bucketKey,
            bucketPath: uploadResult.fileInfo.userFolder,
            fileSize: uploadResult.fileInfo.size,
            fileType: file.name.endsWith('.md') ? 'markdown' : 'text',
            uploadedAt: uploadResult.fileInfo.uploadedAt
          }
        })
      });
      await refreshWizardState();
    } catch (error) {
      console.warn('Failed to save file metadata to user document:', error);
    }
  }

  // Create uploaded file object
  const uploadedFile: UploadedFile = {
    id: `file-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    name: file.name,
    size: file.size,
    type: file.name.endsWith('.md') ? 'markdown' : 'text',
    content: text,
    originalFile: file,
    bucketKey: uploadResult.fileInfo.bucketKey,
    bucketPath: uploadResult.fileInfo.userFolder,
    fileUrl: uploadResult.fileInfo.fileUrl,
    uploadedAt: new Date()
  };

  uploadedFiles.value.push(uploadedFile);
  if (wizardUploadIntent.value === 'other') {
    const importedName = uploadResult.fileInfo.fileName || file.name;
    stage3PendingUploadName.value = null;
    stage3LastImportedName.value = importedName;
    // no-op
  }
};

const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
};

const viewFile = (file: UploadedFile, page?: number) => {
  viewingFile.value = file;
  
  // Determine file type - use detectFileTypeFromMetadata if type is not set or invalid
  let fileType = file.type;
  if (!fileType || (fileType !== 'pdf' && fileType !== 'text' && fileType !== 'markdown')) {
    fileType = detectFileTypeFromMetadata(file.name || '', file.type);
  }
  
  // Open appropriate viewer based on detected type
  if (fileType === 'pdf') {
    pdfInitialPage.value = page;
    showPdfViewer.value = true;
    showTextViewer.value = false;
  } else {
    // Default to text viewer for text, markdown, and unknown types
    showTextViewer.value = true;
    showPdfViewer.value = false;
  }
};

// Process markdown content to convert page references to clickable links
// Strategy: Find "page"/"Page" + number in markdown, insert HTML links before parsing
const processPageReferences = (content: string): string => {
  const pdfFiles = uploadedFiles.value.filter(f => f.type === 'pdf');

  // First pass: resolve `[File N p.<page>]` legend-tag citations into
  // direct hyperlinks. The server's Patient Summary prompt instructs
  // the LLM to cite Radiology (and any other long-filename section)
  // using `[File N p.<page>]` form to avoid spelling out unreadable
  // Epic export filenames. File N maps to availableUserFiles[N-1]
  // among PDFs (References excluded — the server uses the same
  // filter as /api/user-files when building the legend). We rewrite
  // the matched text inline as a clickable anchor that preserves
  // the short `File N p.<page>` label.
  // File-N citation rewrite + wrap + legend-footer is shared with
  // MyStuffDialog (Patient Summary tab) via src/utils/fileNCitations.
  content = processFileNCitations(content, availableUserFiles.value);
  
  // Find all occurrences of a page reference: full word `Page`/`page`
  // OR the abbreviated `p.` form. The abbreviated form is what the
  // v1.4.13 NEW-AGENT.txt § Source Citations instruction tells the
  // agent to emit ("[<filename> p.<page>]"), and what the
  // deterministic lab-history renderer in this file emits per row.
  // Pattern matches: "Page 24", "page 24", "Page: 24", "page:24",
  // "Page:** 24", "**Page:** 27", AND "p.24" / "p. 24" / "p.**24**".
  // Note: requires a word boundary BEFORE the page word so we don't
  // hit "p" inside larger tokens (we want to match "p.24" but not the
  // "p" in "patient24"). The `\.` after `p` in the abbreviated form is
  // mandatory — bare `p` without a dot is too noisy to risk matching.
  const pageReferencePattern = /\b(Page|page|p\.)[\s:*-]*(\d+)/gi;
  const pageReferences: Array<{ fullMatch: string; pageWord: string; pageNum: number; index: number }> = [];
  
  let match;
  pageReferencePattern.lastIndex = 0;
  while ((match = pageReferencePattern.exec(content)) !== null) {
    pageReferences.push({
      fullMatch: match[0],
      pageWord: match[1],
      pageNum: parseInt(match[2], 10),
      index: match.index
    });
  }
  
  if (pageReferences.length === 0) {
    return markdownParser.render(content);
  }
  
  // Find PDF filenames in the content
  // Look for filenames with various labels: File:, Filename:, Document:, or standalone
  // Also handle markdown formatting like **Filename:** or **File:**
  const pdfFilenamePatterns = [
    /\*\*(?:File|Filename|Document|Source):\*\*\s*([A-Za-z0-9_\-\.]+\.(?:PDF|pdf))/gi, // Markdown bold with label
    /(?:File|Filename|Document|Source):\s*([A-Za-z0-9_\-\.]+\.(?:PDF|pdf))/gi, // With label (no markdown)
    /([A-Za-z0-9_\-\.]+\.(?:PDF|pdf))/gi // Standalone
  ];
  const pdfFilenames: Array<{ filename: string; index: number; label?: string }> = [];
  
  // First, find filenames with labels (including markdown)
  for (const pattern of pdfFilenamePatterns) {
    pattern.lastIndex = 0;
    let filenameMatch: RegExpExecArray | null;
    while ((filenameMatch = pattern.exec(content)) !== null) {
      const filename = filenameMatch[1] || filenameMatch[0];
      // Avoid duplicates
      if (!pdfFilenames.some(f => f.filename === filename && f.index === filenameMatch!.index)) {
        pdfFilenames.push({ 
          filename: filename, 
          index: filenameMatch.index,
          label: filenameMatch[0].includes(':') ? filenameMatch[0].split(':')[0].replace(/\*/g, '') : undefined
        });
      }
    }
  }
  
  // Sort by index
  pdfFilenames.sort((a, b) => a.index - b.index);
  
  // Process page references in reverse order to preserve indices
  let processedContent = content;
  
  for (let i = pageReferences.length - 1; i >= 0; i--) {
    const { fullMatch, pageNum, index } = pageReferences[i];
    
    // Skip if this text is already inside an HTML tag (to avoid double-linking).
    // Window is large because our File-N legend pre-pass (above) emits
    // anchors whose `title=` / `data-filename=` attributes can hold
    // very long Epic-export filenames; a small window would miss the
    // opening `<a ` and let this loop re-wrap `p.<N>` inside those
    // anchors.
    const beforeMatch = processedContent.substring(Math.max(0, index - 1500), index);
    if (beforeMatch.includes('<a ') && !beforeMatch.includes('</a>')) {
      continue;
    }
    
    // Find the closest PDF filename before or after this page reference
    // If there's only one filename in the context (within 200 chars before/after), use it regardless of label
    let matchedFilename: string | null = null;
    let matchedFile: UploadedFile | null = null;
    
    const contextStart = Math.max(0, index - 200);
    const contextEnd = Math.min(content.length, index + fullMatch.length + 200);
    
    // Find all filenames in the context
    const filenamesInContext = pdfFilenames.filter(f => 
      f.index >= contextStart && f.index <= contextEnd
    );
    
    // If there's exactly one filename in context, use it (regardless of label or position)
    if (filenamesInContext.length === 1) {
      matchedFilename = filenamesInContext[0].filename;
      matchedFile = pdfFiles.find(f => {
        const nameUpper = f.name?.toUpperCase();
        const filenameUpper = matchedFilename!.toUpperCase();
        return nameUpper === filenameUpper || 
               nameUpper.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
               filenameUpper.includes(nameUpper.replace(/\.(PDF|pdf)$/, ''));
      }) || null;
      
      // If not found in uploadedFiles, check availableUserFiles (if already loaded)
      if (!matchedFile && matchedFilename && availableUserFiles.value.length > 0) {
        const matchedUserFile = availableUserFiles.value.find(f => {
          const fileUpper = f.fileName?.toUpperCase();
          const filenameUpper = matchedFilename!.toUpperCase();
          return fileUpper === filenameUpper || 
                 fileUpper?.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
                 filenameUpper.includes(fileUpper?.replace(/\.(PDF|pdf)$/, '') || '');
        });
        
        if (matchedUserFile) {
          // Create a pseudo-file object for matching
          matchedFile = {
            name: matchedUserFile.fileName,
            bucketKey: matchedUserFile.bucketKey
          } as UploadedFile;
        }
      }
    } else {
      // Multiple filenames or none - use the closest one before the page reference
      const filenameBefore = pdfFilenames.filter(f => f.index < index);
      if (filenameBefore.length > 0) {
        matchedFilename = filenameBefore[filenameBefore.length - 1].filename;
        matchedFile = pdfFiles.find(f => {
          const nameUpper = f.name?.toUpperCase();
          const filenameUpper = matchedFilename!.toUpperCase();
          return nameUpper === filenameUpper || 
                 nameUpper.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
                 filenameUpper.includes(nameUpper.replace(/\.(PDF|pdf)$/, ''));
        }) || null;
      }
    }
    
    // Create the HTML link (markdown allows raw HTML)
    let linkHtml: string;
    if (matchedFile && matchedFilename) {
      const escapedText = fullMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      linkHtml = `<a href="#" class="page-link" data-filename="${matchedFilename}" data-page="${pageNum}" data-bucket-key="${matchedFile.bucketKey || ''}">${escapedText}</a>`;
    } else if (pdfFiles.length === 1) {
      const singleFile = pdfFiles[0];
      const escapedText = fullMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      linkHtml = `<a href="#" class="page-link" data-filename="${singleFile.name}" data-page="${pageNum}" data-bucket-key="${singleFile.bucketKey || ''}">${escapedText}</a>`;
    } else {
      // Check if filename found in bubble matches a file in availableUserFiles
      let matchedUserFile: { fileName: string; bucketKey: string } | null = null;
      if (matchedFilename) {
        matchedUserFile = availableUserFiles.value.find(f => {
          const fileUpper = f.fileName?.toUpperCase();
          const filenameUpper = matchedFilename!.toUpperCase();
          return fileUpper === filenameUpper || 
                 fileUpper?.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
                 filenameUpper.includes(fileUpper?.replace(/\.(PDF|pdf)$/, '') || '');
        }) || null;
      }
      
      if (matchedUserFile && matchedFilename) {
        // Found a match in user files - create direct link
        const escapedText = fullMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        linkHtml = `<a href="#" class="page-link" data-filename="${matchedFilename}" data-page="${pageNum}" data-bucket-key="${matchedUserFile.bucketKey}">${escapedText}</a>`;
      } else if (matchedFilename) {
        // We found a filename in the AI response but haven't matched it yet
        // Store the filename in the link so it can be matched when files are loaded on click
        const escapedText = fullMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        linkHtml = `<a href="#" class="page-link page-link-chooser" data-filename="${matchedFilename}" data-page="${pageNum}">${escapedText}</a>`;
      } else {
        // No filename found - create chooser link without filename
        const escapedText = fullMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        linkHtml = `<a href="#" class="page-link page-link-chooser" data-page="${pageNum}">${escapedText}</a>`;
      }
    }
    
    // Replace the text in the markdown content
    const before = processedContent.substring(0, index);
    const after = processedContent.substring(index + fullMatch.length);
    processedContent = before + linkHtml + after;
  }
  
  return markdownParser.render(processedContent);
};

// Processed message HTML (reactive to file lists so Saved Files links become direct after preload).
// During streaming, skip heavy processPageReferences for the growing message so the UI stays responsive.
const messageDisplayHtml = computed(() => {
  // Depend on file lists so we re-run when Saved Files load (processPageReferences uses them)
  void availableUserFiles.value;
  void uploadedFiles.value;
  const list = messages.value;
  const n = list.length;
  const streaming = isStreaming.value;
  if (streaming && n > 0) {
    return list.map((msg, idx) =>
      idx === n - 1 ? markdownParser.render(msg.content) : processPageReferences(msg.content)
    );
  }
  return list.map(msg => processPageReferences(msg.content));
});

// Handle click on page link
const handlePageLinkClick = async (event: Event) => {
  event.preventDefault();
  const target = event.target as HTMLElement;
  const link = target.closest('.page-link') as HTMLElement;
  
  if (!link) return;
  
  const pageNum = link.getAttribute('data-page');
  if (!pageNum) return;
  
  const pageNumber = parseInt(pageNum, 10);
  
  // Late-binding legend-tag resolution: if the link's visible text
  // matches `File N p.<page>` (a Patient Summary Radiology citation
  // emitted by the server's legend-tag prompt), resolve File N against
  // the PDF-only ordering of availableUserFiles — same indexing the
  // server uses when building the legend. This covers the cases the
  // render-time pre-pass in processPageReferences couldn't:
  //   - availableUserFiles loaded AFTER the message rendered, and
  //     the computed didn't pick up the change (defensive belt-and-
  //     suspenders to the existing reactive dependency).
  //   - the link was created as a chooser fallback because the
  //     pre-pass conditional was false at render time.
  const linkText = (link.textContent || '').trim();
  const fileNMatch = linkText.match(/^\s*File\s+(\d+)\s+p\.?\s*(\d+)\s*$/i);
  if (fileNMatch) {
    let pool = availableUserFiles.value.filter(f => /\.pdf$/i.test(f.fileName || ''));
    if (pool.length === 0 && !loadingUserFiles.value) {
      await loadUserFilesForChooser(false);
      pool = availableUserFiles.value.filter(f => /\.pdf$/i.test(f.fileName || ''));
    }
    const idx = parseInt(fileNMatch[1], 10) - 1;
    const target = pool[idx];
    if (target) {
      const targetPage = parseInt(fileNMatch[2], 10);
      const userFile: UploadedFile = {
        id: `user-file-${target.bucketKey}`,
        name: target.fileName,
        size: 0,
        type: detectFileTypeFromMetadata(target.fileName, target.fileType),
        content: '',
        originalFile: null as any,
        bucketKey: target.bucketKey,
        uploadedAt: new Date()
      };
      viewFile(userFile, targetPage);
      return;
    }
    // No such File N in the pool — fall through to existing behavior.
  }

  // Check if this is a chooser link (no filename specified)
  if (link.classList.contains('page-link-chooser')) {
    const pdfFiles = uploadedFiles.value.filter(f => f.type === 'pdf');
    
    // If we have PDFs in the current chat, use them
    if (pdfFiles.length > 1) {
      // Multiple PDFs in chat, show chooser with those
      pendingPageLink.value = { pageNum: pageNumber };
      showDocumentChooser.value = true;
      return;
    } else if (pdfFiles.length === 1) {
      // Single PDF in chat, use it
      viewFile(pdfFiles[0], pageNumber);
      return;
    }
    
    // No PDFs in current chat - check if filename in link matches a user file
    const filename = link.getAttribute('data-filename');
    if (filename) {
      // Lazy-load user files if not already loaded
      if (availableUserFiles.value.length === 0 && !loadingUserFiles.value) {
        // Load files first, then try to match after loading completes
        pendingPageLink.value = { pageNum: pageNumber };
        await loadUserFilesForChooser(false);
        
        // After loading, try to match the filename
        const matchedUserFile = availableUserFiles.value.find(f => {
          const fileUpper = f.fileName?.toUpperCase();
          const filenameUpper = filename.toUpperCase();
          return fileUpper === filenameUpper || 
                 fileUpper?.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
                 filenameUpper.includes(fileUpper?.replace(/\.(PDF|pdf)$/, '') || '');
        });
        
        if (matchedUserFile) {
          const userFile: UploadedFile = {
            id: `user-file-${matchedUserFile.bucketKey}`,
            name: matchedUserFile.fileName,
            size: 0,
            type: detectFileTypeFromMetadata(matchedUserFile.fileName, matchedUserFile.fileType),
            content: '',
            originalFile: null as any,
            bucketKey: matchedUserFile.bucketKey,
            uploadedAt: new Date()
          };
          viewFile(userFile, pageNumber);
          pendingPageLink.value = null;
          return;
        }
        
        // No match found after loading - show chooser
        showDocumentChooser.value = true;
        return;
      }
      
      // Check availableUserFiles if already loaded
      const matchedUserFile = availableUserFiles.value.find(f => {
        const fileUpper = f.fileName?.toUpperCase();
        const filenameUpper = filename.toUpperCase();
        return fileUpper === filenameUpper || 
               fileUpper?.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
               filenameUpper.includes(fileUpper?.replace(/\.(PDF|pdf)$/, '') || '');
      });
      
      if (matchedUserFile) {
        const userFile: UploadedFile = {
          id: `user-file-${matchedUserFile.bucketKey}`,
          name: matchedUserFile.fileName,
          size: 0,
          type: detectFileTypeFromMetadata(matchedUserFile.fileName, matchedUserFile.fileType),
          content: '',
          originalFile: null as any,
          bucketKey: matchedUserFile.bucketKey,
          uploadedAt: new Date()
        };
        viewFile(userFile, pageNumber);
        return;
      }
    }
    
    // No match found - fetch user files and show chooser
    pendingPageLink.value = { pageNum: pageNumber };
    loadUserFilesForChooser();
    return;
  }
  
  // Regular link with filename
  const filename = link.getAttribute('data-filename');
  const bucketKey = link.getAttribute('data-bucket-key');
  
  if (!filename) return;
  
  // Find the file in uploadedFiles (current chat)
  const file = uploadedFiles.value.find(f => 
    f.name?.toUpperCase() === filename.toUpperCase() ||
    (bucketKey && f.bucketKey === bucketKey) ||
    f.name?.toUpperCase().includes(filename.toUpperCase().replace(/\.(PDF|pdf)$/, ''))
  );
  
  if (file) {
    viewFile(file, pageNumber);
    return;
  }
  
  // File not in uploadedFiles - check if it's a user file with bucketKey
  if (bucketKey && filename) {
    // Create a user file object and view it
    const userFile: UploadedFile = {
      id: `user-file-${bucketKey}`,
      name: filename,
      size: 0,
      type: detectFileTypeFromMetadata(filename),
      content: '',
      originalFile: null as any,
      bucketKey: bucketKey,
      uploadedAt: new Date()
    };
    viewFile(userFile, pageNumber);
  }
};

// Load user files for the document chooser (lazy-loaded when needed)
const loadUserFilesForChooser = async (showChooser = true) => {
  if (!props.user?.userId) {
    if (showChooser) {
      showDocumentChooser.value = true; // Show chooser anyway (might be empty)
    }
    return;
  }
  
  // Skip loading if already loading
  if (loadingUserFiles.value) {
    if (showChooser) {
      showDocumentChooser.value = true;
    }
    return;
  }
  
  loadingUserFiles.value = true;
  try {
    const response = await fetch(`/api/user-files?userId=${encodeURIComponent(props.user.userId)}`, {
      credentials: 'include'
    });
    
    if (response.ok) {
      const result = await response.json();
      // Include PDF, text, and markdown files (not just PDFs)
      const userFiles = (result.files || [])
        .filter((f: any) => {
          const fileName = f.fileName?.toLowerCase() || '';
          const fileType = f.fileType?.toLowerCase();
          return fileType === 'pdf' || fileType === 'text' || fileType === 'markdown' ||
                 fileName.endsWith('.pdf') || fileName.endsWith('.txt') || 
                 fileName.endsWith('.md') || fileName.endsWith('.markdown');
        })
        .map((f: any) => ({
          fileName: f.fileName,
          bucketKey: f.bucketKey,
          fileType: f.fileType || detectFileTypeFromMetadata(f.fileName)
        }));
      
      availableUserFiles.value = userFiles;
    } else {
      availableUserFiles.value = [];
    }
  } catch (error) {
    console.error('Error loading user files:', error);
    availableUserFiles.value = [];
  } finally {
    loadingUserFiles.value = false;
    if (showChooser) {
      showDocumentChooser.value = true;
    }
  }
};

// Close document chooser and clear state
const closeDocumentChooser = () => {
  showDocumentChooser.value = false;
  pendingPageLink.value = null;
  availableUserFiles.value = [];
};

// Handle document selection from chooser
const handleDocumentSelected = (file: UploadedFile | { fileName: string; bucketKey: string }) => {
  if (!pendingPageLink.value) return;
  
  // Check if it's a user file (from account) or uploaded file (from chat)
  // User files have fileName property but no id property
  if ('fileName' in file && 'bucketKey' in file && !('id' in file)) {
    // User file from account - create a minimal UploadedFile-like object
    const fileType = 'fileType' in file ? (file.fileType as string | undefined) : undefined;
    const userFile: UploadedFile = {
      id: `user-file-${file.bucketKey}`,
      name: file.fileName,
      size: 0,
      type: detectFileTypeFromMetadata(file.fileName, fileType),
      content: '',
      originalFile: null as any,
      bucketKey: file.bucketKey,
      uploadedAt: new Date()
    };
    viewFile(userFile, pendingPageLink.value.pageNum);
  } else {
    // Regular uploaded file from chat
    viewFile(file as UploadedFile, pendingPageLink.value.pageNum);
  }
  
  pendingPageLink.value = null;
  showDocumentChooser.value = false;
};

const removeFile = (file: UploadedFile) => {
  const index = uploadedFiles.value.findIndex(f => f.id === file.id);
  if (index !== -1) {
    uploadedFiles.value.splice(index, 1);
  }
};

const markdownParser = new MarkdownIt({
  html: true, // Allow HTML so we can render clickable page links
  linkify: true,
  breaks: true,
  typographer: true
});

const pdfMargin = { top: 48, right: 48, bottom: 48, left: 48 };
const bubbleWidthRatio = 0.9;
const bubblePaddingX = 14;
const bubblePaddingY = 12;
const authorChipHeight = 16;
const authorChipPaddingX = 6;
const authorChipSpacing = 8;
const metaChipHeight = 14;
const metaChipPaddingX = 5;
const metaChipSpacing = 6;
const bubbleSpacing = 24;
const baseFontSize = 8;
const headingFontSizes: Record<number, number> = { 1: 14, 2: 12, 3: 10, 4: 9 };
const lineHeight = 11;
const bulletIndent = 14;
const fileChipHeight = 24;
const fileChipPaddingX = 12;
const fileChipSpacing = 10;
const fileIconSize = 12;
const eyeIconSize = 12;

interface MarkedToken {
  text?: string;
  bold?: boolean;
  newline?: boolean;
}

interface MessageBlock {
  type: 'paragraph' | 'heading' | 'bullet';
  level?: number;
  text: string;
}

type SegmentItemKind = 'padding' | 'block' | 'gap' | 'meta' | 'actions';

interface MarkedSegment {
  text: string;
  bold: boolean;
}

interface MarkedLine {
  segments: MarkedSegment[];
  bullet: boolean;
}

interface BlockSegmentData {
  fontSize: number;
  lineHeight: number;
  indent: number;
  line: MarkedLine;
}

interface SegmentItem {
  kind: SegmentItemKind;
  height: number;
  blockData?: BlockSegmentData;
  chips?: string[];
}

interface RenderState {
  cursorY: number;
  pageWidth: number;
  pageHeight: number;
}

interface MessageMeasurement {
  bubbleHeight: number;
  contentHeight: number;
  metaHeight: number;
  totalHeight: number;
  items: SegmentItem[];
  metaChips: string[];
}

const inlineToMarkedText = (inline: any): string => {
  let result = '';
  let bold = false;

  inline?.children?.forEach((child: any) => {
    switch (child.type) {
      case 'strong_open':
        bold = true;
        break;
      case 'strong_close':
        bold = false;
        break;
      case 'text':
      case 'code_inline':
        if (child.content) {
          result += bold ? `**${child.content}**` : child.content;
        }
        break;
      case 'softbreak':
      case 'hardbreak':
        result += '\n';
        break;
      default:
        break;
    }
  });

  return result.trim();
};

const tokenizeMarkedText = (text: string): MarkedToken[] => {
  const tokens: MarkedToken[] = [];
  let buffer = '';
  let bold = false;
  let i = 0;

  while (i < text.length) {
    if (text.startsWith('**', i)) {
      if (buffer) {
        tokens.push({ text: buffer, bold });
        buffer = '';
      }
      bold = !bold;
      i += 2;
      continue;
    }

    if (text[i] === '\n') {
      if (buffer) {
        tokens.push({ text: buffer, bold });
        buffer = '';
      }
      tokens.push({ newline: true });
      i += 1;
      continue;
    }

    buffer += text[i];
    i += 1;
  }

  if (buffer) {
    tokens.push({ text: buffer, bold });
  }

  return tokens;
};

const buildMarkedLines = (
  doc: jsPDF,
  text: string,
  fontSize: number,
  maxWidth: number
): MarkedLine[] => {
  const tokens = tokenizeMarkedText(text);
  const lines: MarkedLine[] = [];
  let currentSegments: MarkedSegment[] = [];
  let cursorWidth = 0;

  const pushLine = () => {
    const segments = [...currentSegments];

    while (segments.length > 0 && segments[0].text.trim().length === 0) {
      segments.shift();
    }

    while (segments.length > 0 && segments[segments.length - 1].text.trim().length === 0) {
      segments.pop();
    }

    if (segments.length === 0) {
      lines.push({ segments: [{ text: '', bold: false }], bullet: false });
    } else {
      lines.push({ segments, bullet: false });
    }

    currentSegments = [];
    cursorWidth = 0;
  };

  tokens.forEach(token => {
    if (token.newline) {
      pushLine();
      return;
    }

    if (!token.text) return;

    const parts = token.text.split(/(\s+)/).filter(Boolean);

    parts.forEach(part => {
      doc.setFont('helvetica', token.bold ? 'bold' : 'normal');
      doc.setFontSize(fontSize);
      const isWhitespace = /^\s+$/.test(part);
      const width = doc.getTextWidth(part);

      if (isWhitespace) {
        if (cursorWidth + width > maxWidth && currentSegments.length > 0) {
          pushLine();
        } else {
          currentSegments.push({ text: part, bold: token.bold ?? false });
          cursorWidth += width;
        }
        return;
      }

      if (width > maxWidth) {
        const broken = doc.splitTextToSize(part, maxWidth);
        broken.forEach((piece: string, index: number) => {
          const pieceWidth = doc.getTextWidth(piece);
          if (cursorWidth > 0 && cursorWidth + pieceWidth > maxWidth) {
            pushLine();
          }
          currentSegments.push({ text: piece, bold: token.bold ?? false });
          cursorWidth += pieceWidth;
          if (index < broken.length - 1) {
            pushLine();
          }
        });
        return;
      }

      if (cursorWidth > 0 && cursorWidth + width > maxWidth) {
        pushLine();
      }

      currentSegments.push({ text: part, bold: token.bold ?? false });
      cursorWidth += width;
    });
  });

  if (currentSegments.length > 0) {
    pushLine();
  }

  if (lines.length === 0) {
    lines.push({ segments: [{ text: '', bold: false }], bullet: false });
  }

  return lines;
};

const normalizeText = (text: string): string => (
   text
     .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
     .replace(/[\u00AD\u2010\u2011]/g, '-')
     .replace(/[\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
     .replace(/[\u2012-\u2015\u2212]/g, '-')
     .replace(/\u00A0/g, ' ')
     .replace(/\s+\n/g, '\n')
     .replace(/\n\s+/g, '\n')
     .replace(/\s+/g, ' ')
     .trim()
 );

const ensureRoom = (doc: jsPDF, state: RenderState, requiredHeight: number) => {
  if (state.cursorY + requiredHeight > state.pageHeight - pdfMargin.bottom) {
    doc.addPage();
    state.cursorY = pdfMargin.top;
  }
};

// @ts-ignore
const renderMarkedText = (
  doc: jsPDF,
  text: string,
  startX: number,
  startY: number,
  width: number,
  options: { fontSize: number; lineSpacing: number }
) => {
  const tokens = tokenizeMarkedText(text);
  const lineSpacing = options.lineSpacing;
  let cursorX = startX;
  let cursorY = startY;

  tokens.forEach(token => {
    if (token.newline) {
      cursorY += lineSpacing;
      cursorX = startX;
      return;
    }

    if (!token.text) return;

    const parts = token.text.split(/(\s+)/).filter(Boolean);

    parts.forEach(part => {
      const isWhitespace = /^\s+$/.test(part);
      doc.setFont('helvetica', token.bold ? 'bold' : 'normal');
      doc.setFontSize(options.fontSize);

      if (isWhitespace) {
        cursorX += doc.getTextWidth(part);
        return;
      }

      const broken = doc.splitTextToSize(part, width);
      broken.forEach((piece: string, index: number) => {
        const pieceWidth = doc.getTextWidth(piece);
        if (cursorX !== startX && cursorX - startX + pieceWidth > width) {
          cursorY += lineSpacing;
          cursorX = startX;
        }

        doc.text(piece, cursorX, cursorY, { baseline: 'top' });
        cursorX += pieceWidth;

        if (index < broken.length - 1) {
          cursorY += lineSpacing;
          cursorX = startX;
        }
      });
    });
  });

  return cursorY - startY + lineSpacing;
};

const getBlocksFromMessage = (message: Message): MessageBlock[] => {
  if (!message.content) {
    return [{ type: 'paragraph', text: '' }];
  }

  const tokens = markdownParser.parse(message.content, {});
  const blocks: MessageBlock[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.type === 'table_open') {
      const tableRows: string[][] = [];
      let j = i + 1;
      let currentRow: string[] = [];

      for (; j < tokens.length; j += 1) {
        const tableToken = tokens[j];

        if (tableToken.type === 'tr_open') {
          currentRow = [];
        }

        if (tableToken.type === 'tr_close') {
          if (currentRow.length > 0) {
            tableRows.push(currentRow);
          }
          currentRow = [];
        }

        if (tableToken.type === 'th_open' || tableToken.type === 'td_open') {
          const inlineCell = tokens[j + 1];
          if (inlineCell?.type === 'inline') {
            currentRow.push(inlineToMarkedText(inlineCell));
          } else {
            currentRow.push('');
          }
        }

        if (tableToken.type === 'table_close') {
          break;
        }
      }

      if (tableRows.length > 0) {
        tableRows.forEach((row, index) => {
          const text = row.join(' | ');
          const formatted = index === 0 ? `**${text}**` : text;
          blocks.push({ type: 'paragraph', text: formatted });
        });
      }

      i = j;
      continue;
    }

    if (token.type !== 'inline') continue;

    const prevToken = tokens[i - 1];
    if (!prevToken) continue;

    if (prevToken.type === 'heading_open') {
      const level = parseInt(prevToken.tag.replace('h', ''), 10) || 3;
      blocks.push({ type: 'heading', level, text: inlineToMarkedText(token) });
      continue;
    }

    if (prevToken.type === 'paragraph_open') {
      const beforeParagraph = tokens[i - 2];
      if (beforeParagraph && beforeParagraph.type === 'list_item_open') {
        blocks.push({ type: 'bullet', text: inlineToMarkedText(token) });
      } else {
        blocks.push({ type: 'paragraph', text: inlineToMarkedText(token) });
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph', text: message.content });
  }

  return blocks;
};

const drawDocumentIcon = (doc: jsPDF, x: number, y: number, width: number, height: number) => {
   doc.setDrawColor(25, 118, 210);
   doc.setFillColor(255, 255, 255);
   doc.roundedRect(x, y, width, height, 2, 2, 'FD');
   doc.setFillColor(227, 242, 253);
   doc.setFillColor(187, 222, 251);
   doc.rect(x + width * 0.15, y + height * 0.65, width * 0.7, height * 0.15, 'F');
 };
 
 const drawEyeIcon = (doc: jsPDF, x: number, y: number, width: number, height: number) => {
   const centerX = x + width / 2;
   const centerY = y + height / 2;
   doc.setDrawColor(79, 195, 247);
   doc.setFillColor(255, 255, 255);
   doc.ellipse(centerX, centerY, width / 2, height / 2, 'FD');
   doc.setFillColor(79, 195, 247);
   doc.circle(centerX, centerY, Math.min(width, height) / 4, 'F');
 };

const renderFileChips = (doc: jsPDF, files: UploadedFile[], state: RenderState) => {
  if (!files.length) {
    return;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(baseFontSize + 2);

  if (state.cursorY + lineHeight > state.pageHeight - pdfMargin.bottom) {
    doc.addPage();
    state.cursorY = pdfMargin.top;
  }

  doc.setTextColor(62, 62, 62);
  doc.text('Attached Files', pdfMargin.left, state.cursorY);
  state.cursorY += lineHeight;

  let rowY = state.cursorY;
  let currentX = pdfMargin.left;

  files.forEach(file => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(baseFontSize + 1);
    const textWidth = doc.getTextWidth(file.name);
    const chipWidth = fileChipPaddingX * 2 + fileIconSize + 6 + textWidth + 8 + eyeIconSize;

    if (currentX + chipWidth > state.pageWidth - pdfMargin.right) {
      currentX = pdfMargin.left;
      rowY += fileChipHeight + fileChipSpacing;
    }

    if (rowY + fileChipHeight > state.pageHeight - pdfMargin.bottom) {
      doc.addPage();
      state.cursorY = pdfMargin.top;
      rowY = state.cursorY;
      currentX = pdfMargin.left;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(baseFontSize + 2);
      doc.text('Attached Files (cont.)', pdfMargin.left, rowY);
      rowY += lineHeight;
    }

    doc.setDrawColor(187, 222, 251);
    doc.setFillColor(227, 242, 253);
    doc.roundedRect(currentX, rowY, chipWidth, fileChipHeight, 6, 6, 'FD');

    const iconY = rowY + (fileChipHeight - fileIconSize) / 2;
    drawDocumentIcon(doc, currentX + fileChipPaddingX / 2, iconY, fileIconSize, fileIconSize);

    doc.setTextColor(25, 118, 210);
    const textX = currentX + fileChipPaddingX / 2 + fileIconSize + 6;
    const textY = rowY + fileChipHeight / 2 + 3;
    doc.text(file.name, textX, textY, { baseline: 'middle' });

    const eyeX = currentX + chipWidth - eyeIconSize - fileChipPaddingX / 2;
    const eyeY = rowY + (fileChipHeight - eyeIconSize) / 2;
    drawEyeIcon(doc, eyeX, eyeY, eyeIconSize, eyeIconSize);

    currentX += chipWidth + fileChipSpacing;
  });

  state.cursorY = rowY + fileChipHeight + bubbleSpacing;
  doc.setTextColor(32, 32, 32);
};

const measureMessage = (doc: jsPDF, message: Message, bubbleWidth: number): MessageMeasurement => {
  const textWidth = bubbleWidth - bubblePaddingX * 2;
  const blocks = getBlocksFromMessage(message);
  const items: SegmentItem[] = [];

  let contentHeight = 0;

  const addItem = (item: SegmentItem) => {
    items.push(item);
    contentHeight += item.height;
  };

  addItem({ kind: 'padding', height: bubblePaddingY });

  blocks.forEach(block => {
    const fontSize = block.type === 'heading' ? headingFontSizes[block.level || 3] || baseFontSize : baseFontSize;
    const blockLineHeight = block.type === 'heading' ? Math.round(fontSize * 1.4) : lineHeight;
    const indent = block.type === 'bullet' ? bulletIndent : 0;

    const normalizedText = normalizeText(block.text);
    const lines = buildMarkedLines(doc, normalizedText, fontSize, Math.max(textWidth - indent, 24));

    lines.forEach((line, index) => {
      const lineData: MarkedLine = {
        segments: line.segments,
        bullet: block.type === 'bullet' && index === 0
      };
      addItem({
        kind: 'block',
        height: blockLineHeight,
        blockData: {
          fontSize,
          lineHeight: blockLineHeight,
          indent,
          line: lineData
        }
      });
    });
  });

  const metaChips = Array.isArray((message as any)?.metaChips)
    ? ((message as any).metaChips as string[])
    : [];

  let metaHeight = 0;
  if (metaChips.length > 0) {
    let lineWidth = 0;
    let lines = 1;
    metaChips.forEach(chip => {
      const chipTextWidth = doc.getTextWidth(chip);
      const chipWidth = chipTextWidth + metaChipPaddingX * 2;
      if (lineWidth > 0 && lineWidth + chipWidth > textWidth) {
        lines += 1;
        lineWidth = 0;
      }
      lineWidth += chipWidth + 6;
    });
    metaHeight = lines * metaChipHeight + (lines - 1) * metaChipSpacing;
    addItem({ kind: 'gap', height: metaChipSpacing });
    addItem({ kind: 'meta', height: metaHeight, chips: metaChips });
  }

  addItem({ kind: 'padding', height: bubblePaddingY });

  const bubbleHeight = contentHeight;
  const totalHeight = authorChipHeight + authorChipSpacing + bubbleHeight + bubbleSpacing;

  return {
    bubbleHeight,
    contentHeight,
    metaHeight,
    totalHeight,
    metaChips,
    items
  };
};

const drawBubbleSegmentBackground = (
  doc: jsPDF,
  bubbleX: number,
  bubbleWidth: number,
  segmentTop: number,
  segmentHeight: number,
  isFirst: boolean,
  isLast: boolean,
  bubbleFill: [number, number, number],
  bubbleBorder: [number, number, number]
) => {
  const radius = 8;
  doc.setFillColor(bubbleFill[0], bubbleFill[1], bubbleFill[2]);
  doc.setDrawColor(bubbleBorder[0], bubbleBorder[1], bubbleBorder[2]);

  if (isFirst && isLast) {
    doc.roundedRect(bubbleX, segmentTop, bubbleWidth, segmentHeight, radius, radius, 'FD');
    return;
  }

  if (isFirst) {
    doc.roundedRect(bubbleX, segmentTop, bubbleWidth, segmentHeight, radius, radius, 'FD');
    doc.setFillColor(bubbleFill[0], bubbleFill[1], bubbleFill[2]);
    doc.rect(bubbleX, segmentTop + segmentHeight - radius, radius, radius, 'FD');
    doc.rect(bubbleX + bubbleWidth - radius, segmentTop + segmentHeight - radius, radius, radius, 'FD');
    return;
  }

  if (isLast) {
    doc.roundedRect(bubbleX, segmentTop, bubbleWidth, segmentHeight, radius, radius, 'FD');
    doc.setFillColor(bubbleFill[0], bubbleFill[1], bubbleFill[2]);
    doc.rect(bubbleX, segmentTop, radius, radius, 'FD');
    doc.rect(bubbleX + bubbleWidth - radius, segmentTop, radius, radius, 'FD');
    return;
  }

  doc.rect(bubbleX, segmentTop, bubbleWidth, segmentHeight, 'FD');
};

const renderMetaChips = (
  doc: jsPDF,
  chips: string[] | undefined,
  textStartX: number,
  textWidth: number,
  startY: number
) => {
  if (!chips || chips.length === 0) {
    return 0;
  }

  let cursorY = startY;
  let chipCursorX = textStartX;

  chips.forEach(chip => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(baseFontSize + 1);
    const chipTextWidth = doc.getTextWidth(chip);
    const width = chipTextWidth + metaChipPaddingX * 2;

    if (chipCursorX + width > textStartX + textWidth) {
      chipCursorX = textStartX;
      cursorY += metaChipHeight + metaChipSpacing;
    }

    doc.setFillColor(224, 242, 241);
    doc.setDrawColor(180, 208, 203);
    doc.roundedRect(chipCursorX, cursorY, width, metaChipHeight, 4, 4, 'FD');
    doc.setTextColor(46, 125, 109);
    doc.text(
      chip,
      chipCursorX + metaChipPaddingX,
      cursorY + metaChipHeight / 2 + 2,
      { baseline: 'middle' }
    );

    chipCursorX += width + 6;
  });

  doc.setTextColor(32, 32, 32);

  return (cursorY + metaChipHeight) - startY;
};

const renderMessage = (
  doc: jsPDF,
  message: Message,
  state: RenderState,
  bubbleWidth: number,
  measurement: MessageMeasurement
) => {
  const isUser = message.role === 'user';
  const bubbleX = isUser
    ? state.pageWidth - pdfMargin.right - bubbleWidth
    : pdfMargin.left;
  const textStartX = bubbleX + bubblePaddingX;
  const textWidth = bubbleWidth - bubblePaddingX * 2;
  const bubbleFill: [number, number, number] = isUser ? [227, 242, 253] : [245, 245, 245];
  const bubbleBorder: [number, number, number] = isUser ? [187, 222, 251] : [216, 216, 216];
  const chipFill: [number, number, number] = isUser ? [33, 150, 243] : [232, 245, 253];
  const chipBorder: [number, number, number] = isUser ? [25, 118, 210] : [187, 222, 251];
  const chipText: [number, number, number] = isUser ? [255, 255, 255] : [25, 118, 210];

  const authorLabel = getMessageLabel(message);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(baseFontSize + 1);
  const chipTextWidth = doc.getTextWidth(authorLabel);
  const chipWidth = chipTextWidth + authorChipPaddingX * 2;
  const chipX = isUser ? bubbleX + bubbleWidth - chipWidth : bubbleX;
  const chipY = state.cursorY;

  doc.setFillColor(chipFill[0], chipFill[1], chipFill[2]);
  doc.setDrawColor(chipBorder[0], chipBorder[1], chipBorder[2]);
  doc.roundedRect(chipX, chipY, chipWidth, authorChipHeight, 6, 6, 'FD');
  doc.setTextColor(chipText[0], chipText[1], chipText[2]);
  doc.text(
    authorLabel,
    chipX + authorChipPaddingX,
    chipY + authorChipHeight / 2 + 2,
    { baseline: 'middle' }
  );

  state.cursorY += authorChipHeight + authorChipSpacing;
  const items = measurement.items;
  let segmentIndex = 0;

  while (segmentIndex < items.length) {
    let available = state.pageHeight - pdfMargin.bottom - state.cursorY;
    if (available <= bubblePaddingY) {
      doc.addPage();
      state.cursorY = pdfMargin.top;
      available = state.pageHeight - pdfMargin.bottom - state.cursorY;
    }

    const segmentItems: SegmentItem[] = [];
    let segmentHeight = 0;
    let startIndex = segmentIndex;

    while (segmentIndex < items.length) {
      const item = items[segmentIndex];
      const nextHeight = segmentHeight + item.height;

      if (segmentItems.length === 0 && item.height > available) {
        doc.addPage();
        state.cursorY = pdfMargin.top;
        available = state.pageHeight - pdfMargin.bottom - state.cursorY;
        startIndex = segmentIndex;
        segmentHeight = 0;
        continue;
      }

      if (segmentItems.length > 0 && nextHeight > available) {
        if (segmentItems.length === 1 && segmentItems[0].kind === 'padding') {
          segmentItems.length = 0;
          segmentHeight = 0;
          segmentIndex = startIndex;
          doc.addPage();
          state.cursorY = pdfMargin.top;
          available = state.pageHeight - pdfMargin.bottom - state.cursorY;
          continue;
        }
        break;
      }

      segmentItems.push(item);
      segmentHeight = nextHeight;
      segmentIndex += 1;
    }

    if (segmentItems.length === 0) {
      break;
    }

    const segmentTop = state.cursorY;
    const isFirstSegment = startIndex === 0;
    const isLastSegment = segmentIndex >= items.length;

    drawBubbleSegmentBackground(
      doc,
      bubbleX,
      bubbleWidth,
      segmentTop,
      segmentHeight,
      isFirstSegment,
      isLastSegment,
      bubbleFill,
      bubbleBorder
    );

    doc.setTextColor(32, 32, 32);
    let contentCursorY = segmentTop;

    segmentItems.forEach(item => {
      switch (item.kind) {
        case 'padding':
        case 'gap':
          contentCursorY += item.height;
          break;
        case 'block': {
          if (!item.blockData) {
            contentCursorY += item.height;
            break;
          }
          const { fontSize, lineHeight: blockLineHeight, indent, line } = item.blockData;
          const lineY = contentCursorY;
          let lineX = textStartX + indent;

          if (line.bullet) {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(fontSize);
            doc.text('•', textStartX, lineY, { baseline: 'top' });
          }

          line.segments.forEach(segment => {
            if (!segment.text) return;
            doc.setFont('helvetica', segment.bold ? 'bold' : 'normal');
            doc.setFontSize(fontSize);

            if (/^\s+$/.test(segment.text)) {
              lineX += doc.getTextWidth(segment.text);
            } else {
              doc.text(segment.text, lineX, lineY, { baseline: 'top' });
              lineX += doc.getTextWidth(segment.text);
            }
          });

          contentCursorY += blockLineHeight;
          break;
        }
        case 'meta': {
           const rendered = renderMetaChips(doc, item.chips, textStartX, textWidth, contentCursorY);
           contentCursorY += rendered;
           break;
         }
         default:
           contentCursorY += item.height;
       }
     });

    state.cursorY = segmentTop + segmentHeight;
  }

  state.cursorY += bubbleSpacing;
};

const generateChatTranscriptPdf = () => {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const printableWidth = pageWidth - pdfMargin.left - pdfMargin.right;
  const bubbleWidth = Math.min(pageWidth * bubbleWidthRatio, printableWidth);
  const state: RenderState = {
    cursorY: pdfMargin.top,
    pageWidth,
    pageHeight
  };

  renderFileChips(doc, uploadedFiles.value, state);

  messages.value.forEach(msg => {
    const normalized = normalizeMessage({ ...msg });
    const measurement = measureMessage(doc, normalized, bubbleWidth);
    const minHeightNeeded = authorChipHeight + authorChipSpacing + bubblePaddingY;
    ensureRoom(doc, state, minHeightNeeded);
    renderMessage(doc, normalized, state, bubbleWidth, measurement);
  });

  return doc;
};

const saveLocally = async () => {
  try {
    if (messages.value.length === 0) {
      alert('There is no chat content to save yet.');
      return;
    }
    
    const doc = generateChatTranscriptPdf();
    const now = new Date();
    const filename = `MAIA chat ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}.pdf`;

    // Prefer writing to localFolderHandle/chats/ so the file stays
    // in the patient folder but won't be indexed (scanner skips subdirs).
    if (localFolderHandle.value) {
      try {
        // @ts-ignore - getDirectoryHandle not in TS libs
        const chatsDir = await localFolderHandle.value.getDirectoryHandle('chats', { create: true });
        const fileHandle = await chatsDir.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(await doc.output('blob'));
        await writable.close();

        alert('Chat saved successfully!');
        lastLocalSaveSnapshot.value = currentChatSnapshot.value;
        return;
      } catch (err: any) {
        console.warn('Failed to write to chats/ subfolder, falling back to save picker.', err);
      }
    }

    // Fall back to the File System Access save picker
    // @ts-ignore - File System Access API types not in TypeScript libs
    if ('showSaveFilePicker' in window) {
      try {
        // @ts-ignore
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [
            {
            description: 'PDF files',
            accept: { 'application/pdf': ['.pdf'] }
            }
          ]
        });

        const writable = await fileHandle.createWritable();
        await writable.write(await doc.output('blob'));
        await writable.close();

        alert('Chat saved successfully!');
        lastLocalSaveSnapshot.value = currentChatSnapshot.value;
        return;
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          return; // user cancelled
        }
        console.warn('File System Access API not available or failed, falling back to download.', err);
      }
    }

    // Fallback: regular download
    doc.save(filename);
    alert('Chat saved successfully!');
    lastLocalSaveSnapshot.value = currentChatSnapshot.value;
  } catch (error) {
    console.error('Error saving chat locally:', error);
    alert(`Failed to save chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const saveToGroup = async () => {
  try {
    if (!props.user?.userId) {
      alert('You must be logged in to save chats to a group');
      return;
    }

    const payload = {
      chatHistory: buildChatHistoryPayload(),
      uploadedFiles: buildUploadedFilePayload(),
      currentUser: props.user.userId,
      connectedKB: getProviderKey(selectedProvider.value)
    };

    let attemptedUpdate = false;

    if (isDeepLink.value) {
      if (!currentSavedChatId.value && deepLinkChatId.value) {
        currentSavedChatId.value = deepLinkChatId.value;
        currentSavedChatShareId.value = deepLinkShareId.value || currentSavedChatShareId.value;
      }
      if (!currentSavedChatId.value) {
        alert('Unable to locate the shared chat to update. Please refresh and try again.');
        return;
      }
    }

    if (currentSavedChatId.value) {
      attemptedUpdate = true;
      const updateResponse = await fetch(`/api/save-group-chat/${encodeURIComponent(currentSavedChatId.value)}`, {
        method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
        credentials: 'include',
      body: JSON.stringify({
          ...payload,
          shareId: currentSavedChatShareId.value
        })
      });

      if (updateResponse.status === 404) {
        // Existing chat was deleted or not found; fall back to creating a new chat
        currentSavedChatId.value = null;
        currentSavedChatShareId.value = null;
        attemptedUpdate = false;
      } else if (!updateResponse.ok) {
        const errorData = await updateResponse.json().catch(() => ({ message: updateResponse.statusText }));
        throw new Error(errorData.message || 'Failed to update saved chat');
      } else {
        const result = await updateResponse.json();
        const shareId = result.shareId || currentSavedChatShareId.value;

        currentSavedChatId.value = result.chatId || currentSavedChatId.value;
        currentSavedChatShareId.value = shareId || null;
        lastGroupSaveSnapshot.value = currentChatSnapshot.value;

        alert(`Chat updated successfully!${shareId ? ` Share ID: ${shareId}` : ''}`);

        loadSavedChatCount();
        return;
      }
    }

    if (!attemptedUpdate) {
      const createResponse = await fetch('/api/save-group-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      if (!createResponse.ok) {
        const errorData = await createResponse.json().catch(() => ({ message: createResponse.statusText }));
      throw new Error(errorData.message || 'Failed to save chat');
    }

      const result = await createResponse.json();
    
      currentSavedChatId.value = result.chatId || null;
      currentSavedChatShareId.value = result.shareId || null;
      lastGroupSaveSnapshot.value = currentChatSnapshot.value;
    
      alert(`Chat saved successfully!${result.shareId ? ` Share ID: ${result.shareId}` : ''}`);

    loadSavedChatCount();
    }
  } catch (error) {
    console.error('Error saving to group:', error);
    alert(`Failed to save chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const showSavedChats = () => {
  showSavedChatsModal.value = true;
  loadSavedChatCount();
};

const loadSavedChatCount = async () => {
  if (!props.user?.userId) return;
  
  try {
    const endpoint = isDeepLink.value
      ? '/api/user-chats'
      : `/api/user-chats?userId=${encodeURIComponent(props.user.userId)}`;
    const response = await fetch(endpoint, {
      credentials: 'include'
    });
    if (response.ok) {
      const result = await response.json();
      savedChatCount.value = result.count || 0;
    }
  } catch (error) {
    console.error('Failed to load chat count:', error);
  }
};

async function loadDeepLinkChat(force = false) {
  const shareId = deepLinkShareId.value;
  if (!shareId) return;
  if (hasLoadedDeepLinkChat.value && !force) return;

  try {
    const response = await fetch(`/api/load-chat-by-share/${encodeURIComponent(shareId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(response.statusText || 'Failed to load shared chat');
    }
    const result = await response.json();
    if (result?.chat) {
      handleChatSelected(result.chat);
      hasLoadedDeepLinkChat.value = true;
      if (result.chat._id) {
        currentSavedChatId.value = result.chat._id;
      } else if (deepLinkChatId.value) {
        currentSavedChatId.value = deepLinkChatId.value;
      }

      if (result.chat.shareId) {
        currentSavedChatShareId.value = result.chat.shareId;
      } else {
        currentSavedChatShareId.value = shareId;
      }
    }
  } catch (error) {
    console.error('Failed to load deep link chat:', error);
  }
}

const handleChatDeleted = (chatId: string) => {
  if (currentSavedChatId.value === chatId) {
    currentSavedChatId.value = null;
    currentSavedChatShareId.value = null;
    lastGroupSaveSnapshot.value = null;
  }
  loadSavedChatCount();
};

const handleChatSelected = async (chat: any) => {
  currentSavedChatId.value = chat._id || null;
  currentSavedChatShareId.value = chat.shareId || null;
  if (deepLinkShareId.value) {
    hasLoadedDeepLinkChat.value = true;
    deepLinkInfoLocal.value = {
      shareId: deepLinkShareId.value,
      chatId: chat._id || null
    };
    emit('update:deepLinkInfo', deepLinkInfoLocal.value);
  }

  // For deep link users, load the owner's deep link Private AI setting (then reload providers)
  if (isDeepLink.value) {
    if (chat.patientOwner) {
      try {
        const response = await fetch(`/api/user-settings?userId=${encodeURIComponent(chat.patientOwner)}`, {
          credentials: 'include'
        });
        if (response.ok) {
          const result = await response.json();
          ownerAllowDeepLinkPrivateAI.value = result.allowDeepLinkPrivateAI !== undefined ? result.allowDeepLinkPrivateAI : true;
        } else {
          ownerAllowDeepLinkPrivateAI.value = true;
        }
      } catch (error) {
        console.warn('Failed to load owner deep link setting, defaulting to enabled:', error);
        ownerAllowDeepLinkPrivateAI.value = true;
      }
    } else {
      ownerAllowDeepLinkPrivateAI.value = true; // No owner id (e.g. old chat) – allow Private AI
    }
    await loadProviders();
  }

  // Load the chat history
  if (chat.chatHistory) {
    const normalizedHistory = chat.chatHistory.map((msg: Message) => normalizeMessage(msg));
    messages.value = normalizedHistory;
    originalMessages.value = JSON.parse(JSON.stringify(normalizedHistory)); // Keep original in sync
    trulyOriginalMessages.value = JSON.parse(JSON.stringify(normalizedHistory)); // Store truly original for filtering
  }
  
  // Load the uploaded files
  if (chat.uploadedFiles) {
    uploadedFiles.value = chat.uploadedFiles.map((file: any) => ({
      id: file.id || `file-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      name: file.name,
      size: file.size,
      type: file.type,
      content: '', // Content not saved to reduce size
      originalFile: null as any,
      bucketKey: file.bucketKey,
      bucketPath: file.bucketPath,
      uploadedAt: file.uploadedAt ? new Date(file.uploadedAt) : new Date()
    }));
  } else {
    uploadedFiles.value = [];
  }

  nextTick(() => {
    const snapshot = currentChatSnapshot.value;
    lastLocalSaveSnapshot.value = snapshot;
    lastGroupSaveSnapshot.value = snapshot;
  });

  if (deepLinkShareId.value) {
    deepLinkInfoLocal.value = {
      shareId: deepLinkShareId.value,
      chatId: chat._id || null
    };
    emit('update:deepLinkInfo', deepLinkInfoLocal.value);
  }
};

// Reset chat when needed (kept for reference)
// const _clearChat = () => {
//   messages.value = [];
//   uploadedFiles.value = [];
// };

const startEditing = (idx: number) => {
  if (!editingMessageIdx.value.includes(idx)) {
    editingMessageIdx.value.push(idx);
    const message = messages.value[idx];
    if (message) {
      editingOriginalContent.value[idx] = message.content;
    }
  }
};

const saveEditedMessage = (idx: number) => {
  const editIndex = editingMessageIdx.value.indexOf(idx);
  if (editIndex > -1) {
    editingMessageIdx.value.splice(editIndex, 1);
  }
  delete editingOriginalContent.value[idx];
  // Sync originalMessages when message is edited (edited content becomes the new "original")
  if (originalMessages.value[idx] && messages.value[idx]) {
    originalMessages.value[idx].content = messages.value[idx].content;
  }
};

const cancelEditing = (idx: number) => {
  const original = editingOriginalContent.value[idx];
  if (original !== undefined && messages.value[idx]) {
    messages.value[idx].content = original;
  }
  const editIndex = editingMessageIdx.value.indexOf(idx);
  if (editIndex > -1) {
    editingMessageIdx.value.splice(editIndex, 1);
  }
  delete editingOriginalContent.value[idx];
};

const confirmDeleteMessage = (idx: number) => {
  const message = messages.value[idx];
  messageToDelete.value = message;
  
  // Check if deleting an assistant message with a preceding user message
  if (message.role === 'assistant' && idx > 0 && messages.value[idx - 1].role === 'user') {
    precedingUserMessage.value = messages.value[idx - 1];
  } else {
    precedingUserMessage.value = null;
  }
  
  showDeleteDialog.value = true;
};

const deleteMessageConfirmed = () => {
  if (!messageToDelete.value) return;
  
  const idx = messages.value.findIndex(msg => msg === messageToDelete.value);
  if (idx === -1) return;
  
  // Remove the message
  messages.value.splice(idx, 1);
  // Also remove from originalMessages to keep in sync
  if (originalMessages.value[idx]) {
    originalMessages.value.splice(idx, 1);
  }
  
  // If there was a preceding user message, remove it too
  if (precedingUserMessage.value && idx > 0) {
    const userIdx = idx - 1;
    if (messages.value[userIdx]?.role === 'user') {
      messages.value.splice(userIdx, 1);
      // Also remove from originalMessages
      if (originalMessages.value[userIdx]) {
        originalMessages.value.splice(userIdx, 1);
      }
      delete editingOriginalContent.value[userIdx];
    }
  }
  
  // Remove from editing if it was being edited
  const editIndex = editingMessageIdx.value.indexOf(idx);
  if (editIndex > -1) {
    editingMessageIdx.value.splice(editIndex, 1);
  }
  
  // Close modal and reset
  showDeleteDialog.value = false;
  messageToDelete.value = null;
  precedingUserMessage.value = null;
  // Deletion counts as a change, so leave snapshots untouched and let the user re-save if needed
};

// Auto-scroll chat to bottom when messages change
const scrollToBottom = async () => {
  await nextTick();
  await nextTick(); // Double nextTick to ensure DOM is fully updated
  if (chatMessagesRef.value) {
    // Use setTimeout to ensure DOM has fully updated
    setTimeout(() => {
      if (chatMessagesRef.value) {
        chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight;
      }
    }, 0);
  }
};

// Watch for specific changes and trigger scroll with flush: 'post'
watch(() => [messages.value.length, messages.value[messages.value.length - 1]?.content, streamingReasoning.value], () => {
  scrollToBottom();
  if (streamingReasoningRef.value) {
    nextTick(() => {
      if (streamingReasoningRef.value) {
        streamingReasoningRef.value.scrollTop = streamingReasoningRef.value.scrollHeight;
      }
    });
  }
}, { flush: 'post' });

const startSetupWizardPolling = () => {
  if (!props.user?.userId) {
    initialLoadComplete.value = true;
    return;
  }
  if (props.suppressWizard) {
    initialLoadComplete.value = true;
    return;
  }
  const userId = props.user.userId;
  const agentSetupKey = wizardAgentSetupStartedKey(userId);
  const maxAttempts = 60; // 15 minutes at 15s
  let attempts = 0;
  agentSetupTimedOut.value = false;
  agentSetupPollingActive.value = true;
  wizardStage1Complete.value = false;
  try {
    const stored = agentSetupKey ? sessionStorage.getItem(agentSetupKey) : null;
    if (stored) {
      const startedAt = parseInt(stored, 10);
      const maxAgeMs = 20 * 60 * 1000;
      if (!isNaN(startedAt) && (Date.now() - startedAt) < maxAgeMs) {
        agentSetupElapsed.value = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      } else {
        if (agentSetupKey) sessionStorage.removeItem(agentSetupKey);
        agentSetupElapsed.value = 0;
        if (agentSetupKey) sessionStorage.setItem(agentSetupKey, String(Date.now()));
      }
    } else {
      agentSetupElapsed.value = 0;
      if (agentSetupKey) sessionStorage.setItem(agentSetupKey, String(Date.now()));
    }
  } catch {
    agentSetupElapsed.value = 0;
  }

  refreshWizardState()
    .then(() => {
      // ── Safari/basic reload recovery: resume guided flow if indexing already done ──
      // On reload wizardFlowPhase resets to 'done'. If the server shows
      // indexing complete + agent ready but Medications or Patient Summary
      // are still unverified, the user was mid-guided-flow. Resume at the
      // earliest unfinished step so the wizard doesn't get stuck.
      // Skip entirely during the post-Restore grace window — otherwise this
      // generates a fresh draft summary and overwrites what Restore restored.
      const setupAlreadyCompleted = (() => { try { return sessionStorage.getItem('wizardSetupCompleted') === 'true'; } catch { return false; } })();
      if (
        !isPostRestoreLocked() &&
        !setupAlreadyCompleted &&
        wizardFlowPhase.value === 'done' &&
        (safariFolderName.value || localFolderHandle.value) &&
        indexingStatus.value?.phase === 'complete' &&
        wizardStage1Complete.value &&
        !wizardPatientSummary.value
      ) {
        if (!wizardCurrentMedications.value) {
          // Meds not yet verified → resume at medications phase.
          wizardFlowPhase.value = 'medications';
          try {
            sessionStorage.setItem('autoProcessInitialFile', 'true');
            sessionStorage.setItem('wizardMyListsAuto', 'true');
          } catch { /* ignore */ }
          myStuffInitialTab.value = 'lists';
          showMyStuffDialog.value = true;
          logProvisioningEvent({ event: 'setup-resumed', reason: 'current-medications-not-verified' });
        } else {
          // Meds verified, summary still a draft → resume at summary phase.
          // (Common after Restore: restored Patient Summary is a draft until
          // the user verifies it. Logged once: the phase flip to 'summary'
          // keeps this block from re-entering.)
          wizardFlowPhase.value = 'summary';
          myStuffInitialTab.value = 'summary';
          showMyStuffDialog.value = true;
          logProvisioningEvent({ event: 'setup-resumed', reason: 'patient-summary-not-verified' });
        }
      }

      if (!shouldHideSetupWizard.value && !showAgentSetupDialog.value && !wizardDismissed.value && !showMyStuffDialog.value) {
        showAgentSetupDialog.value = true;
        stopAgentSetupTimer();
        agentSetupTimer = setInterval(() => {
          agentSetupElapsed.value += 1;
        }, 1000);
      }
      initialLoadComplete.value = true;
    })
    .catch(() => {
      initialLoadComplete.value = true;
    });

  const poll = async () => {
    attempts += 1;
    try {
      const response = await fetch('/api/agent-setup-status', {
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error(`Status ${response.status}`);
      }
      const result = await response.json();
      if (result?.status) {
        agentSetupStatus.value = result.status;
      }
      wizardAgentReady.value = !!result?.endpointReady;
      await refreshWizardState();

      if (shouldHideSetupWizard.value) {
        stopAgentSetupTimer();
        agentSetupPollingActive.value = false;
        showAgentSetupDialog.value = false;
        agentSetupTimedOut.value = false;
        return;
      }

      if (result?.endpointReady) {
        agentSetupStatus.value = 'READY';
        wizardStage1Complete.value = true;
        agentSetupPollingActive.value = false;
        wizardAgentDeployElapsed.value = agentSetupElapsed.value || null;
        stopAgentSetupTimer();
        logProvisioningEvent({
          event: 'agent-deployed',
          agentId: null,
          elapsedMs: agentSetupElapsed.value ? agentSetupElapsed.value * 1000 : null
        });
        try {
          if (agentSetupKey) sessionStorage.removeItem(agentSetupKey);
        } catch { /* ignore */ }
        updateContextualTip();
        // Refetch providers so Private AI appears without page reload (await so UI updates before we return)
        await loadProviders();
        // Populate model name for wizard UI
        wizardPrimaryModelName.value = labelForProfileKey('default');
        // Deploy secondary agent right after primary completes
        wizardDeploySecondary();
        return;
      }

      if (!shouldHideSetupWizard.value && !showAgentSetupDialog.value && !wizardDismissed.value && !showMyStuffDialog.value) {
        showAgentSetupDialog.value = true;
        stopAgentSetupTimer();
        agentSetupTimer = setInterval(() => {
          agentSetupElapsed.value += 1;
        }, 1000);
      }
    } catch (error) {
      console.warn('Agent setup status check failed:', error);
    }

    if (attempts < maxAttempts) {
      setTimeout(poll, 15000);
    } else {
      agentSetupTimedOut.value = true;
      agentSetupPollingActive.value = false;
      stopAgentSetupTimer();
      try {
        if (agentSetupKey) sessionStorage.removeItem(agentSetupKey);
      } catch { /* ignore */ }
    }
  };

  poll();
};

// Deploy secondary agent from wizard (fire-and-forget after primary completes)
const wizardDeploySecondary = async () => {
  if (!props.user?.userId || wizardSecondaryDeploying.value || gptAgentReady.value) return;
  wizardSecondaryDeploying.value = true;
  wizardSecondaryFailed.value = false;
  wizardSecondaryElapsed.value = 0;
  const startedAt = Date.now();
  wizardSecondaryTimer = setInterval(() => {
    wizardSecondaryElapsed.value = Math.round((Date.now() - startedAt) / 1000);
  }, 1000);
  logProvisioningEvent({ event: 'secondary-provision-started' });

  try {
    const res = await fetch('/api/agents/ensure-secondary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.user.userId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);

    if (data.ready) {
      gptAgentReady.value = true;
      if (wizardSecondaryTimer) { clearInterval(wizardSecondaryTimer); wizardSecondaryTimer = null; }
      wizardSecondaryDeploying.value = false;
      logProvisioningEvent({ event: 'secondary-provision-ready', elapsedSeconds: wizardSecondaryElapsed.value });
      await loadProviders();
      return;
    }

    // Poll until ready (max 3 min)
    const maxMs = 180000;
    while (Date.now() - startedAt < maxMs) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const pollRes = await fetch('/api/agents/ensure-secondary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: props.user.userId })
        });
        const pollData = await pollRes.json().catch(() => ({}));
        if (pollData.ready) {
          gptAgentReady.value = true;
          if (wizardSecondaryTimer) { clearInterval(wizardSecondaryTimer); wizardSecondaryTimer = null; }
          wizardSecondaryDeploying.value = false;
          logProvisioningEvent({ event: 'secondary-provision-ready', elapsedSeconds: wizardSecondaryElapsed.value });
          await loadProviders();
          return;
        }
      } catch { /* retry */ }
    }
    throw new Error('Timed out after 3 minutes');
  } catch (e: any) {
    if (wizardSecondaryTimer) { clearInterval(wizardSecondaryTimer); wizardSecondaryTimer = null; }
    wizardSecondaryDeploying.value = false;
    wizardSecondaryFailed.value = true;
    logProvisioningEvent({ event: 'secondary-provision-failed', error: e.message });
  }
};

// Indexing status tracking
const indexingStatus = ref<{
  active: boolean;
  phase: string;
  tokens: string;
  filesIndexed: number;
  progress: number;
} | null>(null);
const stage3IndexingActive = computed(() =>
  stage3IndexingPending.value ||
  indexingStatus.value?.phase === 'indexing' ||
  !!stage3IndexingPoll.value
);

/** True when the user has connected a local folder (Chrome handle or Safari folder name). */
const setupFolderConnected = computed(() => !!localFolderHandle.value || !!safariFolderName.value);

/** Checklist file items for the simplified setup wizard. */
const setupChecklistFiles = computed(() => {
  // Build from wizardStage3Files (server-known files) and auto-run phase
  const uploadedSet = new Set<string>();
  const runningSet = new Set<string>();
  for (const f of wizardStage3Files.value) {
    uploadedSet.add(f.name);
  }
  // If auto-run is active, files being uploaded show as running
  if (localFolderAutoRunActive.value && localFolderAutoRunPhase.value.startsWith('Uploading ')) {
    const match = localFolderAutoRunPhase.value.match(/^Uploading (.+)\.\.\.$/);
    if (match) runningSet.add(match[1]);
  }

  // Combine: local folder files (pending/running) + uploaded files (done) + failed files (error)
  const items: Array<{ name: string; status: 'pending' | 'running' | 'done' | 'error'; progress?: string; isAppleHealth?: boolean }> = [];
  const seen = new Set<string>();

  // Files from local folder scan (not yet uploaded)
  for (const f of localFolderFiles.value) {
    if (f.name.toLowerCase() === 'maia-log.pdf') continue;
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    const isApple = stage3DisplayFiles.value.some(df => df.name === f.name && df.isAppleHealth);
    if (uploadedSet.has(f.name)) {
      items.push({ name: f.name, status: 'done', progress: 'Uploaded', isAppleHealth: isApple });
    } else if (runningSet.has(f.name)) {
      items.push({ name: f.name, status: 'running', isAppleHealth: isApple });
    } else {
      items.push({ name: f.name, status: 'pending', isAppleHealth: isApple });
    }
  }

  // Files from stage3 that may have been uploaded before folder was scanned (e.g. Safari)
  for (const f of stage3DisplayFiles.value) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    items.push({ name: f.name, status: f.inKnowledgeBase ? 'done' : 'pending', progress: f.inKnowledgeBase ? 'Uploaded' : undefined, isAppleHealth: f.isAppleHealth });
  }

  return items;
});

// True once every Setup stage the user is waiting on has finished.
const setupAllComplete = computed(() => {
  const agentReady = wizardStage1Complete.value;
  const kbDone = indexingStatus.value?.phase === 'complete' || !stage3HasFiles.value;
  const recordsDone = !stage3HasFiles.value
    || (wizardCurrentMedications.value && wizardPatientSummary.value);
  return agentReady && kbDone && recordsDone && !wizardPreparingRecords.value;
});

// Persistent bottom status line for the Setup wizard. Derived from the
// existing reactive state (not a flag that gets cleared early), so it
// stays accurate through upload → agent deploy → KB indexing → verify,
// in both local and cloud environments.
const wizardStatusLine = computed(() => {
  if (setupAllComplete.value) return 'Setup complete.';
  if (wizardPreparingRecords.value) {
    return wizardPreparingMessage.value || 'Preparing your health records…';
  }
  if (localFolderAutoRunActive.value && localFolderAutoRunPhase.value) {
    return localFolderAutoRunPhase.value;
  }
  if (agentSetupTimedOut.value && !wizardStage1Complete.value) {
    return 'AI agent deployment timed out — see maia-log.pdf';
  }
  if (stage3IndexingActive.value) {
    const n = Number(stage2StatusDisplay.value.tokens);
    const tok = Number.isFinite(n) && n > 0 ? `${n.toLocaleString()} tokens` : 'indexing';
    return `Indexing knowledge base… (${tok}) — can take 5 to 60 minutes`;
  }
  if (!wizardStage1Complete.value && agentSetupPollingActive.value) {
    const s = agentSetupElapsed.value;
    return s
      ? `Deploying AI agent… (${Math.floor(s / 60)}m ${s % 60}s)`
      : 'Deploying AI agent…';
  }
  if (stage2StatusDisplay.value.completed && !wizardCurrentMedications.value) {
    return 'Verify your Current Medications to continue.';
  }
  if (wizardCurrentMedications.value && !wizardPatientSummary.value
      && stage2StatusDisplay.value.completed) {
    return 'Verify your Patient Summary to continue.';
  }
  return 'Working…';
});

// Log when indexing completes (watch indexingStatus phase transition to 'complete')
// Placed here because indexingStatus must be declared before the watcher.
watch(
  () => indexingStatus.value?.phase,
  (phase, oldPhase) => {
    if (phase === 'complete' && oldPhase !== 'complete' && (localFolderHandle.value || safariFolderName.value)) {
      const tokens = indexingStatus.value?.tokens || '0';
      const filesIndexed = indexingStatus.value?.filesIndexed || 0;
      const elapsed = stage3IndexingStartedAt.value
        ? Math.round((Date.now() - stage3IndexingStartedAt.value) / 1000)
        : 0;
      logProvisioningEvent({
        event: 'kb-indexed',
        tokens: parseInt(String(tokens)) || 0,
        fileCount: parseInt(String(filesIndexed)) || 0,
        elapsedMs: elapsed ? elapsed * 1000 : null
      });
      void generateSetupLogPdf();
    }
  }
);

// Log when Current Medications becomes verified
watch(
  () => wizardCurrentMedications.value,
  (verified, was) => {
    if (verified && !was && (localFolderHandle.value || safariFolderName.value)) {
      void generateSetupLogPdf();
    }
  }
);

// Guided flow: when indexing completes AND agent is ready, close wizard and start medications flow.
// Also watches wizardFlowPhase so that a re-run (where KB and agent are already ready)
// triggers the preparation phase as soon as the wizard sets flowPhase to 'running'.
watch(
  [() => indexingStatus.value?.phase, () => wizardStage1Complete.value, () => wizardFlowPhase.value],
  async ([phase, agentReady, flowPhase]) => {
    if (
      phase === 'complete' &&
      agentReady &&
      (localFolderHandle.value || safariFolderName.value) &&
      flowPhase === 'running' &&
      !wizardPreparingRecords.value
    ) {
      // Both indexing and agent are done — transition to medications phase.
      // Keep the wizard dialog OPEN with spinners so the user doesn't see a zombie chat.
      void generateSetupLogPdf();
      wizardPreparingRecords.value = true;
      wizardPreparingStartedAt.value = Date.now();
      startStage3ElapsedTimer();
      logProvisioningEvent({ event: 'preparation-phase-started' });
      wizardPreparingMessage.value = 'Confirming knowledge base is attached to your agent...';
      if (wizardTimeoutTimer) {
        clearTimeout(wizardTimeoutTimer);
        wizardTimeoutTimer = null;
      }
      guidedFlowDismissCount.value = 0;

      // Populate model name for wizard UI from loaded profiles
      wizardPrimaryModelName.value = labelForProfileKey('default');

      // Secondary agent provisioning runs in the background (started during
      // indexing). No need to block here — draft PS uses primary only.

      // Step 1: Generate and save the draft Patient Summary.
      preGeneratedSummary.value = null;
      if (props.user?.userId) {
        logProvisioningEvent({ event: 'draft-summary-call-started' });
        wizardDraftPsStatus.value = 'running';
        wizardDraftPsStartedAt.value = Date.now();
        wizardDraftPsModel.value = wizardPrimaryModelName.value;
        startStage3ElapsedTimer();
        wizardPreparingMessage.value = `Generating draft Patient Summary (may take up to 20 minutes)...`;
        const draftAbort = new AbortController();
        const draftTimeout = setTimeout(() => draftAbort.abort(), 20 * 60 * 1000);
        try {
          const genRes = await fetch('/api/patient-summary/draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: draftAbort.signal,
            body: JSON.stringify({ userId: props.user.userId })
          });
          clearTimeout(draftTimeout);
          if (!genRes.ok) throw new Error(`HTTP ${genRes.status}`);
          const genResult = await genRes.json();
          const text = (genResult.summary || '').trim();
          if (text) {
            // Server has stored this on userDoc.draftPatientSummary (not in the
            // committed patientSummaries array). It will be promoted only after
            // the user verifies medications and the summary. We keep the text in
            // a local ref so downstream code can read it without re-fetching.
            preGeneratedSummary.value = text;
            const summaryLines = text.split('\n').filter((l: string) => l.trim()).length;
            const generationSeconds = typeof genResult.generationSeconds === 'number'
              ? genResult.generationSeconds
              : Math.round(((Date.now() - wizardDraftPsStartedAt.value) / 1000) * 10) / 10;
            wizardDraftPsStatus.value = 'done';
            wizardDraftPsCompletedAt.value = Date.now();
            stopStage3ElapsedTimer();
            logProvisioningEvent({
              event: 'draft-summary-generated',
              lines: summaryLines,
              chars: text.length,
              generationSeconds
            });
          } else {
            wizardDraftPsStatus.value = 'failed';
            console.warn('[Wizard] Draft Patient Summary returned empty text');
          }
        } catch (err: any) {
          clearTimeout(draftTimeout);
          wizardDraftPsStatus.value = 'failed';
          stopStage3ElapsedTimer();
          const draftElapsed = ((Date.now() - wizardDraftPsStartedAt.value) / 1000).toFixed(1);
          console.warn(`[Wizard] Draft Patient Summary generation failed after ${draftElapsed}s:`, err);
          logProvisioningEvent({
            event: 'draft-summary-failed',
            reason: String(err),
            elapsedSeconds: Number(draftElapsed)
          });
        }
      }

      // Step 2: Medication Worksheets are NOT auto-generated during setup.
      // Users can generate them on demand from the Lists tab.

      // Step 3: open My Lists → Current Medications for the user to VERIFY.
      logProvisioningEvent({ event: 'medications-phase-opened' });
      wizardFlowPhase.value = 'medications';
      wizardPreparingMessage.value = 'Opening Current Medications for review...';
      wizardPreparingRecords.value = false;
      try {
        sessionStorage.setItem('autoProcessInitialFile', 'true');
        sessionStorage.setItem('wizardMyListsAuto', 'true');
      } catch { /* ignore */ }
      myStuffInitialTab.value = 'lists';
      showMyStuffDialog.value = true;
      showAgentSetupDialog.value = false;
    }
  }
);


// ── TEST MODE: Auto-verify watchers ──────────────────────────────
// In testMode, automatically verify medications and summary when the wizard
// opens MyStuff to those tabs. Also auto-dismiss the wizard CONTINUE button.

// Auto-click CONTINUE when KB + Agent are ready in testMode
watch(
  () => testMode.value && wizardStage1Complete.value && (indexingStatus.value?.phase === 'complete') && !wizardPreparingRecords.value && showAgentSetupDialog.value,
  (ready) => {
    if (ready && testMode.value) {
      addTestLog('Agent + KB ready — auto-continuing');
      // Small delay to let UI render the checkmarks
      setTimeout(() => dismissWizard(), 500);
    }
  }
);

// Auto-verify medications: when MyStuff opens to lists tab during medications phase in testMode
watch(
  () => testMode.value && wizardFlowPhase.value === 'medications' && showMyStuffDialog.value,
  async (shouldAutoVerify) => {
    if (!shouldAutoVerify || !testMode.value) return;
    addTestLog('Medications tab opened — waiting for auto-process...');
    // Poll until wizardCurrentMedications becomes true or 10s timeout
    // (Lists.vue displays medications but doesn't auto-save; we'll handle the save ourselves)
    const start = Date.now();
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (wizardCurrentMedications.value || Date.now() - start > 10000) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
    if (wizardCurrentMedications.value) {
      addTestLog('Medications auto-verified');
    } else {
      // Lists.vue populated the UI but didn't auto-save. Check the server for medications,
      // then fall back to extracting from the pre-generated patient summary.
      let medsText = '';
      try {
        const res = await fetch(`/api/user-status?userId=${encodeURIComponent(props.user!.userId)}`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (data.currentMedications && data.currentMedications.trim()) {
            medsText = data.currentMedications;
          }
        }
      } catch { /* ignore */ }
      // If not on server, extract from the pre-generated patient summary
      if (!medsText && preGeneratedSummary.value) {
        const lines = preGeneratedSummary.value.split('\n');
        let inMeds = false;
        const medsLines: string[] = [];
        for (const line of lines) {
          if (/current\s+medications/i.test(line)) { inMeds = true; continue; }
          if (inMeds && /^#{1,3}\s|^\*\*[A-Z]/.test(line) && !/medication/i.test(line)) break;
          if (inMeds && line.trim()) medsLines.push(line);
        }
        medsText = medsLines.join('\n').trim();
      }
      if (medsText) {
        // Save to server so it persists in maia-state.json and can be restored
        try {
          await fetch('/api/user-current-medications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ userId: props.user!.userId, currentMedications: medsText })
          });
        } catch { /* non-fatal */ }
        addTestLog(`Medications extracted from summary (${medsText.split('\n').filter(l => l.trim()).length} lines) — auto-verified`);
        handleCurrentMedicationsSaved({ value: medsText, edited: false, changed: true, verified: true });
      } else {
        addTestLog('Medications not available — proceeding without', false);
        handleCurrentMedicationsSaved({ value: '', edited: false, changed: false, verified: true });
      }
    }
  }
);

// Auto-verify summary: when summary phase starts in testMode
watch(
  () => testMode.value && wizardFlowPhase.value === 'summary',
  async (shouldAutoVerify) => {
    if (!shouldAutoVerify || !testMode.value) return;
    addTestLog('Summary tab opened — auto-verifying...');
    // Wait for summary to be loaded/generated (poll for a few seconds)
    await new Promise(r => setTimeout(r, 3000));
    // Call the verify handler directly
    addTestLog('Summary auto-verified');
    handlePatientSummaryVerified();
  }
);

// After wizard completes in testMode, verify setup and emit to App.vue for Delete → Restore
// Watch the phase directly so we can check the PREVIOUS value — only trigger on summary→done transition
watch(
  () => wizardFlowPhase.value,
  async (phase, oldPhase) => {
    if (phase !== 'done' || oldPhase !== 'summary' || !testMode.value || testSetupVerification.value) return;
    addTestLog('Setup complete — verifying all tabs...');
    try {
      const { verifyAllTabs } = await import('../utils/setupRestoreTest');
      const verification = await verifyAllTabs(props.user!.userId);
      testSetupVerification.value = verification;
      addTestLog(`Files: ${verification.files.count}`, verification.files.count > 0);
      addTestLog(`Agent: ${verification.agentReady ? 'ready' : 'not ready'}`, verification.agentReady);
      addTestLog(`KB: ${verification.kbIndexed ? `indexed (${verification.kbTokens} tokens)` : 'not indexed'}`, verification.kbIndexed);
      addTestLog(`Medications: ${verification.medications.lines} lines`, verification.medications.lines > 0);
      addTestLog(`Summary: ${verification.summary.lines} lines, ${verification.summary.chars} chars`, verification.summary.lines > 0);
      // Ensure maia-state.json is written with latest data before handing off to App.vue
      // (handlePatientSummaryVerified calls generateSetupLogPdf with void — it may not have finished)
      await generateSetupLogPdf();
      addTestLog('Setup verification complete — requesting Delete + Restore cycle...');
      // Emit to App.vue to handle Delete → Restore → Verify
      emit('test-setup-complete', { verification, folderHandle: localFolderHandle.value! });
    } catch (err: any) {
      addTestLog(`Setup verification failed: ${err.message}`, false);
    }
  }
);

const handleIndexingStarted = (data: { jobId: string; phase: string }) => {
  stage3IndexingStartedAt.value = Date.now();
  stage3IndexingCompletedAt.value = null;
  try {
    const k = wizardStage3IndexingStartedKey(props.user?.userId);
    if (k) sessionStorage.setItem(k, String(stage3IndexingStartedAt.value));
  } catch { /* ignore */ }
  indexingStatus.value = {
    active: true,
    phase: data.phase,
    tokens: '0',
    filesIndexed: 0,
    progress: 0
  };
  startStage3ElapsedTimer();
  updateContextualTip();
  // Secondary agent provisioning is handled via the My AI Agent workbook tab.
};

const handleIndexingStatusUpdate = (data: { jobId: string; phase: string; tokens: string; filesIndexed: number; progress: number }) => {
  if (indexingStatus.value) {
    indexingStatus.value.phase = data.phase;
    indexingStatus.value.tokens = data.tokens;
    indexingStatus.value.filesIndexed = data.filesIndexed;
    indexingStatus.value.progress = data.progress;
    updateContextualTip();
  }
};

const handleIndexingFinished = (_data: { jobId: string; phase: string; error?: string }) => {
  stage3IndexingCompletedAt.value = Date.now();
  if (stage3IndexingPoll.value) {
    clearInterval(stage3IndexingPoll.value);
    stage3IndexingPoll.value = null;
  }
  stage3IndexingPending.value = false;
  indexingStatus.value = null;
  stopStage3ElapsedTimer();
  try {
    const k = wizardStage3IndexingStartedKey(props.user?.userId);
    if (k) sessionStorage.removeItem(k);
  } catch { /* ignore */ }
  // Update status tip to show normal status
  updateContextualTip();
  refreshWizardState();
  // DO API continues tokenizing after the indexing job reports complete.
  // Refresh again after delays to pick up the final token count.
  setTimeout(() => refreshWizardState(), 30_000);
  setTimeout(() => refreshWizardState(), 90_000);
  // Rebuild Apple Health Lists sidecars after re-indexing so that
  // Lists, OOR Labs, and Patient Summary pick up the current AH file.
  rebuildAppleHealthSidecarsIfNeeded();
  // Prompt to update Patient Summary, but not during wizard-controlled guided flow or if already dismissed this session
  if (wizardFlowPhase.value !== 'medications' && wizardFlowPhase.value !== 'summary' && !postIndexingSummaryDismissedThisSession.value) {
    showPostIndexingSummaryPrompt.value = true;
  }
};

// MyStuffDialog.rebuildListsAfterIndexing handles the full rebuild
// (sidecars + worksheets + Lists UI reload). This is a lightweight
// fallback for when indexing finishes while MyStuffDialog is closed.
const rebuildAppleHealthSidecarsIfNeeded = async () => {
  try {
    const filesResp = await fetch('/api/user-files', { credentials: 'include' });
    if (!filesResp.ok) return;
    const filesData = await filesResp.json();
    const files = Array.isArray(filesData?.files) ? filesData.files : [];
    const ahFile = files.find((f: { isAppleHealth?: boolean; bucketKey?: string }) => f.isAppleHealth && f.bucketKey);
    if (!ahFile) return;
    await fetch('/api/files/lists/process-initial-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ bucketKey: ahFile.bucketKey, fileName: ahFile.fileName, force: true })
    });
    await Promise.allSettled([
      fetch('/api/encounters/worksheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' }),
      fetch('/api/labs/oor-worksheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include' })
    ]);
    console.log('[indexing-finished] Rebuilt AH sidecars + worksheets');
  } catch (e) {
    console.warn('[indexing-finished] AH rebuild failed (non-fatal):', e);
  }
};

const handlePostIndexingUpdateSummary = () => {
  showPostIndexingSummaryPrompt.value = false;
  myStuffInitialTab.value = 'summary';
  requestMyStuffSummaryAction('generate-summary');
  if (!showMyStuffDialog.value) {
    showMyStuffDialog.value = true;
  }
  // If dialog is already open, the requestAction watcher handles the switch
};

const handleFilesArchived = (archivedBucketKeys: string[]) => {
  // Remove files from uploadedFiles that match the given bucketKeys so they no longer show as
  // chat badges or get included in chat context. Used when files are moved to archived, or to
  // the KB folder (userId/<kbName>/) from the wizard or Saved Files.
  uploadedFiles.value = uploadedFiles.value.filter(file => {
    if (!file.bucketKey) return true; // Keep files without bucketKey (text files)
    // Remove files whose bucketKey matches any archived key
    return !archivedBucketKeys.includes(file.bucketKey);
  });
  
  // If PDF viewer is open and showing a file that was archived/moved, close it
  // Empty array means files were moved (from cancel operation) - close viewer to force refresh
  if (showPdfViewer.value && (archivedBucketKeys.length === 0 || 
      (viewingFile.value && viewingFile.value.bucketKey && 
       archivedBucketKeys.includes(viewingFile.value.bucketKey)))) {
    showPdfViewer.value = false;
    viewingFile.value = null;
  }
  
  // Update status tip immediately after files are archived
  updateContextualTip();
};

const handleFileAddedToKb = async (data: { fileName: string; bucketKey: string }) => {
  logProvisioningEvent({ event: 'file-added', fileName: data.fileName });
  // Copy the file to the local MAIA folder so it's available for offline restore
  // Try to reconnect if handle is missing (may work if user gesture chain is still active)
  if (!localFolderHandle.value && props.user?.userId) {
    try {
      const result = await reconnectLocalFolderWithGesture(props.user.userId);
      if (result) {
        localFolderHandle.value = result.handle;
        localFolderName.value = result.folderName;
      }
    } catch { /* ignore */ }
  }
  if (!localFolderHandle.value) {
    return;
  }
  try {
    // Fetch file content via the proxy endpoint
    const resp = await fetch(`/api/files/proxy-pdf/${encodeURIComponent(data.bucketKey)}`, {
      credentials: 'include'
    });
    if (!resp.ok) {
      console.warn(`[localFolder] Failed to fetch file for local copy: ${resp.status}`);
      return;
    }
    const blob = await resp.blob();
    await writeFileToFolder(localFolderHandle.value, data.fileName, blob);

    // Update maia-state.json to reflect the new file
    try {
      const state = await readStateFile(localFolderHandle.value);
      if (state) {
        const files = state.files || [];
        const existing = files.find(f => f.fileName === data.fileName);
        if (!existing) {
          files.push({
            fileName: data.fileName,
            size: blob.size,
            cloudStatus: 'indexed' as const,
            bucketKey: data.bucketKey
          });
          state.files = files;
          await writeStateFile(localFolderHandle.value, state);
        }
      }
    } catch (stateErr) {
      console.warn('[localFolder] Failed to update maia-state.json:', stateErr);
    }

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: `"${data.fileName}" copied to local MAIA folder`,
        timeout: 3000
      });
    }
  } catch (err) {
    console.warn('[localFolder] Failed to copy file to local folder:', err);
  }
};

const handleMessagesFiltered = async (filteredMessages: Message[]) => {
  // Replace current messages with filtered messages
  messages.value = filteredMessages;
  
  // Update originalMessages to reflect current state (for display purposes)
  // BUT keep trulyOriginalMessages unchanged so we can filter again if needed
  originalMessages.value = JSON.parse(JSON.stringify(filteredMessages));
  
  // Force Vue to re-render by triggering a reactive update
  await nextTick();
  
  // Scroll to bottom to show the filtered messages
  setTimeout(() => {
    if (chatMessagesRef.value) {
      chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight;
    }
  }, 100);
};

const handleDiaryPosted = (diaryContent: string) => {
  // Add diary content as a user message to the chat
  const diaryMessage: Message = {
    role: 'user',
    content: diaryContent,
    authorType: 'user',
    authorLabel: 'Patient Diary',
    name: 'Patient Diary'
  };
  
  messages.value.push(diaryMessage);
    originalMessages.value.push(diaryMessage);
    trulyOriginalMessages.value.push(JSON.parse(JSON.stringify(diaryMessage)));
  
  // Scroll to bottom
  nextTick(() => {
    if (chatMessagesRef.value) {
      chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight;
    }
  });
};

const handleReferenceFileAdded = async (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string; isReference: boolean }) => {
  // Add reference file to uploadedFiles (similar to regular file upload)
  try {
    // For PDF files, we need to parse them
    if (file.fileType === 'pdf') {
      // Fetch and parse PDF from bucket
      const parseResponse = await fetch(`/api/files/parse-pdf-from-bucket/${encodeURIComponent(file.bucketKey)}`, {
        method: 'GET',
        credentials: 'include'
      });
      
      if (parseResponse.ok) {
        const parseResult = await parseResponse.json();
        const uploadedFile: UploadedFile = {
          id: `ref-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          name: file.fileName,
          size: file.fileSize,
          type: 'pdf',
          content: parseResult.text || '',
          originalFile: null as any,
          bucketKey: file.bucketKey,
          bucketPath: file.bucketKey.split('/').slice(0, -1).join('/'),
          fileUrl: file.fileUrl,
          uploadedAt: new Date(file.uploadedAt),
          isReference: true
        };
        uploadedFiles.value.push(uploadedFile);
      }
    } else {
      // For text files, fetch content
      const textResponse = await fetch(`/api/files/get-text/${encodeURIComponent(file.bucketKey)}`, {
        method: 'GET',
        credentials: 'include'
      });
      
      if (textResponse.ok) {
        const textResult = await textResponse.json();
        // Determine file type: markdown, text, or other (pdf is already handled in the if branch above)
        const fileType = file.fileType === 'markdown' ? 'markdown' : 'text';
        const uploadedFile: UploadedFile = {
          id: `ref-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          name: file.fileName,
          size: file.fileSize,
          type: fileType,
          content: textResult.content || textResult.text || '',
          originalFile: null as any,
          bucketKey: file.bucketKey,
          bucketPath: file.bucketKey.split('/').slice(0, -1).join('/'),
          fileUrl: file.fileUrl,
          uploadedAt: new Date(file.uploadedAt),
          isReference: true
        };
        uploadedFiles.value.push(uploadedFile);
      }
    }
  } catch (error) {
    console.error('Error adding reference file to chat:', error);
  }
};

const handleMedicationsOffered = (payload: {
  lines: number;
  source: 'apple-health' | 'patient-summary' | 'manual' | 'user-doc';
  outcome: 'success' | 'ai-refusal' | 'ai-error' | 'ai-empty' | 'summary-empty' | 'no-source' | 'agent-not-ready' | 'extract-error';
  detail?: string;
}) => {
  logProvisioningEvent({
    event: 'medications-offered',
    lines: payload.lines,
    source: payload.source,
    outcome: payload.outcome,
    detail: payload.detail
  });
  void generateSetupLogPdf();
};

const handleCurrentMedicationsSaved = async (payload?: { value?: string; edited?: boolean; changed?: boolean; source?: string; verified?: boolean }) => {
  const medsLineCount = payload?.value ? payload.value.split('\n').filter(l => l.trim()).length : 0;
  // Only log when user explicitly verified or edited — auto-saves from the
  // summary-update flow should not produce a duplicate log entry.
  if (payload?.verified || payload?.edited) {
    logProvisioningEvent({
      event: 'medications-saved',
      lines: medsLineCount,
      source: payload?.source || undefined
    });
  }
  wizardCurrentMedications.value = true;
  wizardStage2Complete.value = true;
  wizardStage2Pending.value = false;
  wizardStage2NoDevice.value = false;
  // Optimistically update userResourceStatus so the yellow outline
  // on the My Lists rail icon disappears IMMEDIATELY when the user
  // verifies meds. Without this, the outline lingers until the
  // background refreshWizardState() round-trip completes, which
  // the user perceives as "Verify didn't work." Empty payload
  // value means "cleared" — flip the flag false so the outline
  // reappears (matches the server state we're about to confirm).
  if (userResourceStatus.value) {
    const valueTrimmed = (payload?.value || '').trim();
    userResourceStatus.value = {
      ...userResourceStatus.value,
      hasCurrentMedications: valueTrimmed.length > 0
    };
  }
  // Guided flow: advance from medications → summary IMMEDIATELY (before network calls)
  // to avoid a flash where the medications tab sits in "saved" state.
  // Only advance when the user explicitly clicked Verify (verified=true).
  // Per-row edits/deletes should NOT close the medications view.
  if (wizardFlowPhase.value === 'medications' && payload?.verified) {
    logProvisioningEvent({ event: 'medications-verified' });
    wizardFlowPhase.value = 'summary';
    guidedFlowDismissCount.value = 0;
    void generateSetupLogPdf();
    // Switch to Patient Summary tab and text-patch the provisional summary with
    // the verified medications. Never a second AI call — the wizard budget is
    // exactly two Private AI calls: summary generation + optional meds extraction.
    myStuffInitialTab.value = 'summary';
    requestMyStuffSummaryAction('update-summary-meds', payload?.value || '');
  }
  // Refresh wizard state in background (non-blocking).
  // Skip for per-row edits/deletes: refreshWizardState fetches
  // GET /api/patient-summary which auto-splices meds into the
  // summary on the server side — we only want that after explicit
  // Verify or Edit.
  if (payload?.verified) {
    void refreshWizardState();
  }
};

const handleMyStuffShowSummary = () => {
  myStuffInitialTab.value = 'summary';
  requestMyStuffSummaryAction('generate-summary');
};

const handleMyStuffTabOpened = (tab: string) => {
  logProvisioningEvent({ event: 'workbook-tab', tab });
};

const handlePatientSummarySaved = async (payload?: { userId?: string; summary?: string }) => {
  {
    // Prefer the text reported by MyStuffDialog (authoritative — what was POSTed).
    // Fall back to preGeneratedSummary only if the payload didn't include one.
    const summaryText = (payload?.summary && payload.summary.length > 0)
      ? payload.summary
      : (preGeneratedSummary.value || '');
    // Keep our cached copy in sync so subsequent events see the post-patch text.
    if (payload?.summary) preGeneratedSummary.value = payload.summary;
    logProvisioningEvent({
      event: 'summary-saved',
      lines: summaryText ? summaryText.split('\n').filter((l: string) => l.trim()).length : 0,
      chars: summaryText.length
    });
  }
  // Saving is not verifying — don't mark PS as verified here.
  // During the guided flow, only handlePatientSummaryVerified completes setup.
  if (wizardFlowPhase.value !== 'summary' && wizardFlowPhase.value !== 'medications') {
    wizardPatientSummary.value = false;
  }
  showAgentSetupDialog.value = false;
  wizardDismissed.value = true;
  await refreshWizardState();
  void generateSetupLogPdf();
};

const handlePatientSummaryVerified = async (payload?: { userId?: string; summary?: string }) => {
  {
    const summaryText = (payload?.summary && payload.summary.length > 0)
      ? payload.summary
      : (preGeneratedSummary.value || '');
    if (payload?.summary) preGeneratedSummary.value = payload.summary;
    logProvisioningEvent({
      event: 'summary-verified',
      lines: summaryText ? summaryText.split('\n').filter((l: string) => l.trim()).length : 0,
      chars: summaryText.length
    });
  }
  wizardPatientSummary.value = true;
  persistWizardCompletion();
  showAgentSetupDialog.value = false;
  wizardDismissed.value = true;
  await refreshWizardState();
  // Guided flow: verifying summary completes the flow immediately.
  // Secondary agent provisioning continues in the background — don't block.
  if (wizardFlowPhase.value === 'summary') {
    wizardFlowPhase.value = 'done';
    try { sessionStorage.setItem('wizardSetupCompleted', 'true'); } catch { /* ignore */ }
    logProvisioningEvent({ event: 'setup-complete' });
    void generateSetupLogPdf();
    setTimeout(() => void generateSetupLogPdf(), 15000);
    emit('wizard-complete');
    showMyStuffDialog.value = false;
  }
};

const handleRehydrationFileRemoved = (payload: { bucketKey?: string; fileName?: string }) => {
  emit('rehydration-file-removed', payload);
};

// Map workflow stages to user-friendly tips
const getWorkflowTip = (workflowStage: string | null, hasFilesInKB: boolean = false): string => {
  const tips: Record<string, string> = {
    'request_sent': 'Support requested. You will be notified when your private AI agent is ready.',
    'agent_deployed': 'Your agent is ready. Use the paperclip to import files for your knowledge base.',
    'files_stored': hasFilesInKB ? 'Ready to chat' : 'Update your knowledge base using the [Stored Files] tab.',
    'files_archived': 'Update your knowledge base using the [Stored Files] tab.',
    'indexing': 'Knowledge base being indexed. This can take up to 60 minutes.',
    'patient_summary': 'Your patient summary is available. Ask your agent for it in the chat anytime.',
    'link_stored': 'Open [Saved Chats] to restore one or share a deep link.'
  };
  
  return tips[workflowStage || ''] || '';
};

const updateContextualTip = async () => {
  if (!props.user?.userId) {
    contextualTip.value = 'User not logged in';
    return;
  }

  // Priority 1: If indexing is active, show indexing status
  if (indexingStatus.value && indexingStatus.value.active) {
    const status = indexingStatus.value;
    if (status.phase === 'indexing' || status.phase === 'indexing_started') {
      contextualTip.value = 'Knowledge base being indexed. This can take up to 60 minutes.';
    } else if (status.phase === 'complete') {
      contextualTip.value = `KB Indexing Complete: ${status.filesIndexed} files indexed`;
      // Clear after a short delay
      setTimeout(() => {
        indexingStatus.value = null;
        updateContextualTip();
      }, 3000);
    } else if (status.phase === 'error') {
      contextualTip.value = 'KB Indexing Error';
      // Clear after a short delay
      setTimeout(() => {
        indexingStatus.value = null;
        updateContextualTip();
      }, 5000);
    } else {
      contextualTip.value = `KB Setup: ${status.phase}`;
    }
    return;
  }

  try {
    // Priority 2: Fetch user document to get workflowStage
    const userResponse = await fetch(`/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, {
      credentials: 'include'
    });

    if (!userResponse.ok) {
      contextualTip.value = 'Unable to load status';
      userResourceStatus.value = null;
      return;
    }

    const userData = await userResponse.json();
    const workflowStage = userData.workflowStage || null;
    const hasKB = !!userData.hasKB;
    const hasFilesInKB = !!userData.hasFilesInKB;
    // /api/user-status doesn't return kbIndexingActive or patient
    // summary status — only refreshWizardState() fetches those.
    // PRESERVE the prior values here (undefined → "unknown", so
    // the wizard spinner doesn't false-trigger before
    // refreshWizardState has run at least once).
    const prior = userResourceStatus.value;
    userResourceStatus.value = {
      hasAgent: !!userData.hasAgent,
      kbStatus: userData.kbStatus || 'none',
      hasKB: hasKB,
      hasFilesInKB: hasFilesInKB,
      workflowStage: workflowStage,
      kbIndexingActive: prior?.kbIndexingActive,
      hasPatientSummary: prior?.hasPatientSummary,
      hasCurrentMedications: !!userData.currentMedications
    };
    
    // Check if workflowStage is 'indexing' (even if frontend polling isn't active)
    if (workflowStage === 'indexing') {
      contextualTip.value = 'Knowledge base being indexed. This can take up to 60 minutes.';
      return;
    }
    
    // Priority 3: Check UI state (public_llm, chat_modified)
    // These are computed, not saved to database
    if (selectedProvider.value !== 'Private AI') {
      contextualTip.value = 'Public AIs see only what you see in the chat, including any paperclip documents.';
      return;
    }
    
    if (messages.value.length > 0) {
      contextualTip.value = 'You can save the chat to your computer or save it online.';
      return;
    }

    // Priority 4: Get tip for workflow stage
    const tip = getWorkflowTip(workflowStage, hasFilesInKB);
    if (tip) {
      contextualTip.value = tip;
    } else {
      // Fallback to default message if no tip found
      // If no KB files, show Tip 7 message
      contextualTip.value = hasFilesInKB ? 'Ready to chat' : 'Ready to chat but your knowledge base is still empty.';
    }
  } catch (error) {
    console.error('Failed to update contextual tip:', error);
    contextualTip.value = 'Error loading status';
    userResourceStatus.value = null;
  }
};

onMounted(async () => {
  // no-op
  void loadWizardMessages();

  // Detect File System Access API support
  localFolderSupported.value = isFileSystemAccessSupported();

  // Load owner's deep link setting first, then providers
  await loadOwnerDeepLinkSetting();
  await loadProviders();
  loadSavedChatCount();

  if (!isDeepLink.value) {
    // Try to reconnect to a previously chosen local folder (silent on Chrome 122+)
    if (localFolderSupported.value) {
      void tryReconnectLocalFolder();
    }

    // Recover Safari folder session from localStorage on reload.
    // If we had a safariFolderName but lost the live File objects (reload),
    // we can still let the wizard show server-sourced progress. If files
    // are already indexed, the watchers won't need the folder handle at all.
    if (props.folderAccessTier === 'safari' || props.folderAccessTier === 'basic') {
      try {
        const sfKey = `safariFolderName-${props.user?.userId}`;
        const stored = sfKey ? localStorage.getItem(sfKey) : null;
        if (stored && !safariFolderName.value) {
          safariFolderName.value = stored;
          localFolderName.value = stored;
          // We have the name but no live File objects — mark that a re-select
          // may be needed if the wizard still requires file uploads.
          safariNeedsReselect.value = true;
        }
      } catch { /* ignore */ }
    }

    startSetupWizardPolling();
    updateContextualTip();
    // Seed userResourceStatus with kbIndexingActive +
    // hasPatientSummary so the Setup Wizard rail spinner reflects
    // real outstanding work on first paint (not just after the
    // user touches the wizard). refreshWizardState is the canonical
    // 3-fetch loader (/api/user-status + /api/user-files +
    // /api/patient-summary) that populates those fields. It's
    // already called from every wizard-progressing event handler,
    // so the spinner stays accurate as the user works through
    // setup.
    void refreshWizardState();
    setTimeout(() => void checkAndShowNeedsIndexingPrompt(), 800);

    // Update tip immediately when context changes (no polling needed for these)
    watch(() => savedChatCount.value, () => {
      updateContextualTip();
    });
    
    watch(() => messages.value.length, () => {
      updateContextualTip();
    });
    
    watch(() => selectedProvider.value, () => {
      updateContextualTip();
    });

    watch(() => showMyStuffDialog.value, (isOpen, wasOpen) => {
      if (isOpen && !wasOpen) {
        logProvisioningEvent({ event: 'workbook-opened' });
      }
      if (wasOpen && !isOpen) {
        logProvisioningEvent({ event: 'workbook-dismissed' });
        showWorkbookClosePrompt.value = false;
        // During guided flow, closing My Lists during the medications phase
        // advances directly to the Patient Summary phase. Per the 2-AI-call spec,
        // if the user didn't verify/edit meds, we keep the provisional summary
        // (with its Apple Health or AI-derived meds section) as-is — no third
        // AI call, no meds-section patch.
        if (wizardFlowPhase.value === 'medications') {
          logProvisioningEvent({ event: 'medications-dismissed' });
          guidedFlowDismissCount.value = 0;
          wizardFlowPhase.value = 'summary';
          void generateSetupLogPdf();
          void nextTick(() => {
            myStuffInitialTab.value = 'summary';
            // No requestMyStuffSummaryAction — the provisional summary is already
            // saved and the Patient Summary tab will load it on open. No AI call.
            showMyStuffDialog.value = true;
          });
          return;
        }
        if (wizardFlowPhase.value === 'summary') {
          guidedFlowDismissCount.value += 1;
          if (guidedFlowDismissCount.value >= 2) {
            // User dismissed Patient Summary twice — complete wizard
            logProvisioningEvent({ event: 'setup-complete' });
            guidedFlowDismissCount.value = 0;
            wizardFlowPhase.value = 'done';
            try { sessionStorage.setItem('wizardSetupCompleted', 'true'); } catch { /* ignore */ }
            void generateSetupLogPdf();
            // Re-generate after delay to pick up server-side admin-notified event
            setTimeout(() => void generateSetupLogPdf(), 15000);
            persistWizardCompletion();
            emit('wizard-complete');
            // Don't reopen — wizard is done
          } else {
            // First dismiss — reopen on the same tab.
            // No requestMyStuffSummaryAction: the summary is already saved and
            // shown; regenerating would exceed the 2-AI-call wizard budget.
            void nextTick(() => {
              myStuffInitialTab.value = 'summary';
              showMyStuffDialog.value = true;
            });
          }
          return;
        }
        if (wizardStage2Pending.value) {
          wizardStage2Pending.value = false;
          refreshWizardState();
        }
        void checkAndShowNeedsIndexingPrompt();
      }
    });
    
    // Conditional polling: only poll when workflowStage requires monitoring
    // Only 'indexing' and 'patient_summary' need polling
    // 'request_sent' doesn't need polling - approval can take hours/days, user will reload to check
    const shouldPollStatus = computed(() => {
      const stage = userResourceStatus.value?.workflowStage;
      return stage === 'indexing' || 
             stage === 'patient_summary';
    });
    
    // Watch for 'request_sent' stage to show modal (only once per session)
    watch(() => userResourceStatus.value?.workflowStage, (newStage) => {
      if (newStage === 'request_sent' && !requestSentModalShown.value) {
        showRequestSentModal.value = true;
        requestSentModalShown.value = true;
      }
    });
    
    // Start/stop polling based on workflowStage
    watch(shouldPollStatus, (needsPolling) => {
      // Clear existing interval
      if (statusPollInterval.value) {
        clearInterval(statusPollInterval.value);
        statusPollInterval.value = null;
      }
      
      // Start polling if needed
      if (needsPolling) {
        statusPollInterval.value = setInterval(() => {
          updateContextualTip();
        }, 5000); // Poll every 5 seconds when needed (faster than 30s for async operations)
      }
    }, { immediate: true });
  } else {
    contextualTip.value = 'Ready to chat';
    loadDeepLinkChat();
    initialLoadComplete.value = true;
  }

  nextTick(() => {
    const snapshot = currentChatSnapshot.value;
    lastLocalSaveSnapshot.value = snapshot;
    lastGroupSaveSnapshot.value = snapshot;
  });

  if (deepLinkShareId.value) {
    loadDeepLinkChat(true);
  }
  
  // Check for pending Current Medications edit deep link
  // This should work whether user is already authenticated or needs to authenticate
  const pendingEdit = sessionStorage.getItem('pendingMedicationsEdit');
  if (pendingEdit && props.user?.userId) {
    try {
      const editData = JSON.parse(pendingEdit);
      if (editData.token && editData.userId === props.user.userId) {
        // Verify token
        const verifyResponse = await fetch(`/api/verify-medications-token?token=${encodeURIComponent(editData.token)}&userId=${encodeURIComponent(editData.userId)}`, {
          credentials: 'include'
        });
        
        if (verifyResponse.ok) {
          const verifyResult = await verifyResponse.json();
          if (verifyResult.valid && !verifyResult.expired) {
            // Token is valid - open My Stuff dialog with Lists tab and auto-edit
            // Use nextTick to ensure dialog is ready
            await nextTick();
            myStuffInitialTab.value = 'lists';
            showMyStuffDialog.value = true;
            // Store flag to auto-edit medications in Lists component
            sessionStorage.setItem('autoEditMedications', 'true');
            // Clear the pending edit from sessionStorage
            sessionStorage.removeItem('pendingMedicationsEdit');
          } else {
            // Token invalid or expired - clear it
            sessionStorage.removeItem('pendingMedicationsEdit');
            if (verifyResult.expired) {
              console.warn('Current Medications edit token has expired');
            } else {
              console.warn('Current Medications edit token is invalid');
            }
          }
        } else {
          console.error('Failed to verify medications token:', verifyResponse.status);
          sessionStorage.removeItem('pendingMedicationsEdit');
        }
      } else {
        // Token or userId mismatch - clear it
        sessionStorage.removeItem('pendingMedicationsEdit');
      }
    } catch (err) {
      console.error('Error processing pending medications edit:', err);
      sessionStorage.removeItem('pendingMedicationsEdit');
    }
  }

  // On load/reload: if agent + files but no KB indexed, show needs-indexing prompt after a short delay
  if (!isDeepLink.value && props.user?.userId) {
    setTimeout(() => checkAndShowNeedsIndexingPrompt(), 1200);
  }

  // Preload Saved Files so page-## links in AI responses can be direct links (not just chooser)
  if (canAccessMyStuff.value && props.user?.userId && availableUserFiles.value.length === 0) {
    loadUserFilesForChooser(false);
  }
});

// Cleanup on unmount (must be at top level, not inside onMounted)
onUnmounted(() => {
  if (statusPollInterval.value) {
    clearInterval(statusPollInterval.value);
    statusPollInterval.value = null;
  }
  if (stage3IndexingPoll.value) {
    clearInterval(stage3IndexingPoll.value);
    stage3IndexingPoll.value = null;
  }
  stopStage3ElapsedTimer();
});

/** Mark indexing as already completed (e.g. after restore) so refreshWizardState
 *  doesn't re-create indexingStatus and trigger a duplicate "Indexing Complete" log entry. */
const markIndexingAlreadyCompleted = () => {
  stage3IndexingCompletedAt.value = Date.now();
};

/** Post-restore grace window. While set, refreshWizardState's "indexing
 *  active" re-poll branch and the post-poll resume-guided-flow logic
 *  (which would generate a fresh draft summary and overwrite what
 *  Restore just restored) are both suppressed. App.vue's
 *  handleRestoreWizardComplete sets this; it auto-expires after 60 s. */
const postRestoreLockUntil = ref<number>(0);
const isPostRestoreLocked = () => Date.now() < postRestoreLockUntil.value;

/** Called from App.vue after Restore completes. Synchronously stamps in
 *  the in-memory wizard flags from server state (so shouldHideSetupWizard
 *  resolves true and the Setup wizard doesn't auto-show), seals the
 *  indexingStatus as complete, and opens a 60 s grace window during which
 *  refreshWizardState side effects are bypassed. */
const markRestoreComplete = async () => {
  postRestoreLockUntil.value = Date.now() + 60_000;
  wizardFlowPhase.value = 'done';
  stage3IndexingCompletedAt.value = Date.now();
  if (!props.user?.userId) return;
  try {
    const [statusRes, summaryRes] = await Promise.all([
      fetch(`/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, { credentials: 'include' }),
      fetch(`/api/patient-summary?userId=${encodeURIComponent(props.user.userId)}`, { credentials: 'include' })
    ]);
    if (statusRes.ok) {
      const status = await statusRes.json();
      if (status.currentMedications && String(status.currentMedications).trim()) {
        wizardCurrentMedications.value = true;
      }
    }
    if (summaryRes.ok) {
      const sum = await summaryRes.json();
      if (sum?.summary && String(sum.summary).trim()) {
        wizardPatientSummary.value = true;
        preGeneratedSummary.value = sum.summary;
      }
    }
    // Seal indexingStatus so the refreshWizardState indexing-active branch
    // (the line 2276 area below) skips the re-poll branch.
    indexingStatus.value = {
      active: false,
      phase: 'complete',
      tokens: indexingStatus.value?.tokens || '0',
      filesIndexed: indexingStatus.value?.filesIndexed || 0,
      progress: 1
    };
  } catch (e) {
    console.warn('[markRestoreComplete] state probe failed:', e);
  }
};

const closeMyStuff = () => {
  showMyStuffDialog.value = false;
};

defineExpose({
  generateSetupLogPdf,
  markIndexingAlreadyCompleted,
  markRestoreComplete,
  refreshWizardState,
  testMode,
  addTestLog,
  setTestFinalOutput,
  closeMyStuff
});
</script>

<style scoped>
.chat-interface {
  width: 100%;
  height: 100vh;
}

.chat-interface .q-card {
  height: 100%;
}

.wizard-slide-scroll {
  max-height: 70vh;
  overflow-y: auto;
}

.wizard-slide-box {
  border: 1px solid #e0e0e0;
  border-top: none !important;
  border-radius: 8px;
  padding: 16px;
  background: #fafafa;
  width: 100%;
  max-width: 720px;
  margin-top: 10px;
}

.wizard-slide-intro {
  max-width: 720px;
  margin-left: 0;
  padding-left: 0;
  border: 0;
  border-bottom: 0 !important;
  box-shadow: none;
}

.wizard-slide-intro {
  text-align: left;
  align-self: flex-start;
}

.wizard-slide-intro hr {
  display: none;
}

.wizard-slide-intro ul,
.wizard-slide-intro li,
.wizard-slide-intro p {
  border: 0 !important;
  box-shadow: none !important;
  background: transparent;
}

.wizard-slide-list {
  margin: 0;
}

.wizard-slide-intro {
  text-align: left;
}

.wizard-slide-item {
  display: flex;
  align-items: center;
  margin-bottom: 6px;
}

.wizard-slide-box-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.wizard-status-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.wizard-medications-not-verified-outline {
  outline: 2px solid var(--q-color-orange-8, #e65100);
  outline-offset: 2px;
}

.wizard-index-now-highlight {
  outline: 2px solid var(--q-color-negative, #c62828);
  outline-offset: 2px;
}

.wizard-verify-btn.q-btn--disabled {
  opacity: 0.3;
}

.wizard-slide-text {
  font-size: 1rem;
  line-height: 1.5;
}

.wizard-slide-image {
  display: block;
  width: 100%;
  height: auto;
  max-height: 70vh;
  object-fit: contain;
}

.wizard-slide-footer {
  padding-top: 0;
}

.wizard-page-dots {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
}

.wizard-page-dots--inline {
  justify-content: flex-start;
  margin-left: 30px;
  width: auto;
  display: inline-flex;
  vertical-align: middle;
}

.wizard-page-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  border: 1px solid #9e9e9e;
  background: transparent;
  padding: 0;
  cursor: pointer;
}

.wizard-page-dot--active {
  width: 12px;
  height: 12px;
  border-width: 2px;
  border-color: #5c6bc0;
}

.chat-messages {
  background-color: #fafafa;
}

.edit-buttons {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.message-preview {
  background: #f8f9fa;
  border: 1px solid #dee2e6;
  border-radius: 4px;
  padding: 10px;
  margin: 10px 0;
}

.message-content {
  margin-top: 5px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.wizard-status-line {
  margin-top: 0;
  line-height: 1.1;
  padding-left: 4px;
}

.wizard-status-file {
  margin-top: 0;
}

.wizard-restore-chip {
  margin-right: 6px;
}

.wizard-status-file + .wizard-status-file {
  margin-top: 2px;
}

.wizard-stage-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  column-gap: 8px;
  align-items: flex-start;
}

.wizard-stage-row + .wizard-stage-row {
  margin-top: 6px;
}

.wizard-stage-col1 {
  width: 32px;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding-top: 0;
  position: relative;
}

.wizard-stage-col1 :deep(.q-checkbox) {
  margin-top: -7px;
  align-self: flex-start;
  line-height: 1;
}

.wizard-stage-col1 :deep(.q-checkbox__inner) {
  margin-top: 0;
}

.wizard-stage-col1 :deep(.q-checkbox__label) {
  margin-top: 0;
}

.wizard-stage-text {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.wizard-stage-label {
  padding-left: 4px;
  line-height: 1.2;
}

.wizard-stage-actions {
  display: flex;
  justify-content: flex-end;
}

.wizard-stage-actions-group {
  display: flex;
  gap: 8px;
}

.wizard-index-btn {
  border: 2px solid var(--q-negative) !important;
}

.wizard-stage3-status {
  font-weight: 600;
  color: var(--q-positive) !important;
}

.wizard-no-device-btn {
  margin-right: 15px;
}

.wizard-heading {
  padding-left: 0;
}

.page-link {
  color: #1976d2;
  text-decoration: underline;
  cursor: pointer;
  font-weight: 500;
}

.page-link:hover {
  color: #1565c0;
  text-decoration: underline;
}

.reasoning-section {
  margin-bottom: 8px;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  overflow: hidden;
}

.reasoning-section.streaming {
  border-color: #90caf9;
  background: #f5f9ff;
}

.reasoning-toggle {
  cursor: pointer;
  padding: 6px 10px;
  font-size: 12px;
  color: #757575;
  user-select: none;
  background: #fafafa;
}

.reasoning-arrow {
  font-size: 10px;
  margin-right: 4px;
}

.reasoning-section.streaming .reasoning-toggle {
  color: #1976d2;
  background: #e3f2fd;
}

.reasoning-content {
  padding: 8px 10px;
  font-size: 12px;
  color: #616161;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
  line-height: 1.5;
}
</style>

