<template>
  <Teleport to="body">
    <!-- The sidebar shell. Three visual states:
           1. Rail-labeled  (default): rail ~180px with icon + label.
           2. Rail-icons:   rail ~60px,  icons only.
           3. Content open: rail (either width) on the left, content
                            panel REPLACES the chat area on the right
                            (full viewport width minus rail).
         Top toggle on the rail switches between states 1 and 2; a
         click on any rail item switches into state 3. Closing the
         content panel (chevron / Esc-equivalent) returns to whichever
         rail mode the user had selected. -->
    <aside
      class="my-stuff-sidebar"
      :class="{
        'my-stuff-sidebar--content-open': isOpen,
        'my-stuff-sidebar--rail-labeled': railLabeled,
        'my-stuff-sidebar--rail-icons': !railLabeled
      }"
      :aria-expanded="isOpen ? 'true' : 'false'"
    >
      <!-- Rail. Always visible (when the component is mounted at all,
           i.e. canAccessMyStuff). Label visibility is driven by the
           rail-labeled / rail-icons class on the parent. -->
      <nav class="my-stuff-rail" aria-label="Workbook">
        <!-- Top of rail: "Workbook" brand + chevron.
             The chevron is context-aware to satisfy the user's
             rule: "When the Workbook sidebar is collapsed, always
             show the chat area."
               - Content panel OPEN  → chevron closes the content
                 (returns to the chat area). Icon: chevron_left,
                 because the panel is to the right of the rail and
                 the action retracts it.
               - Content panel CLOSED → chevron toggles the rail
                 between labeled (~180px) and icons-only (~60px).
                 Icon points the direction the rail will move. -->
        <div class="my-stuff-rail__brand">
          <span v-if="railLabeled" class="my-stuff-rail__brand-label">Workbook</span>
          <button
            type="button"
            class="my-stuff-rail__toggle"
            :class="{ 'close-prompt-highlight': showClosePrompt }"
            :aria-label="chevronAriaLabel"
            :title="chevronTitle"
            @click="chevronClick"
          >
            <q-icon :name="chevronIcon" size="22px" />
          </button>
        </div>
        <div v-if="showClosePrompt && railLabeled" class="close-prompt-banner">
          Close the Workbook to chat
        </div>

        <!-- Setup Wizard — top of the rail list, above all section
             icons. Moved here from the chat header in v1.4.34 so
             every Workbook control lives in the rail.
             When `wizardActive` is true (the parent's
             showAgentSetupDialog is open OR wizardFlowPhase is in
             a non-idle state), a yellow rotating ring appears
             around the icon as a "wizard in progress" indicator. -->
        <button
          type="button"
          class="my-stuff-rail__btn my-stuff-rail__btn--wizard"
          :class="{ 'is-wizard-active': props.wizardActive }"
          :title="props.wizardActive ? 'Setup Wizard — setup incomplete, click to continue' : 'Setup Wizard'"
          aria-label="Setup Wizard"
          @click="handleWizardClick"
        >
          <span class="my-stuff-rail__wizard-icon-wrap">
            <q-icon name="auto_fix_high" size="22px" class="my-stuff-rail__icon" />
            <span v-if="props.wizardActive" class="my-stuff-rail__wizard-ring" aria-hidden="true"></span>
          </span>
          <span class="my-stuff-rail__label">Setup Wizard</span>
          <!-- Blue "setup incomplete" triangle: the wizard never auto-opens
               on reload; this is the passive signal that there is wizard
               work to finish. Same visual language as the Groups alert. -->
          <span
            v-if="props.wizardActive"
            class="my-stuff-rail__info-triangle"
            aria-hidden="true"
          ></span>
          <q-tooltip v-if="props.wizardActive" anchor="center right" self="center left">
            Setup incomplete — click to continue the Setup Wizard
          </q-tooltip>
        </button>

        <button
          v-for="t in railTabs"
          :key="t.name"
          type="button"
          class="my-stuff-rail__btn"
          :class="{
            'is-active': isOpen && currentTab === t.name,
            'has-attention': t.alertOutline
          }"
          :title="t.infoAlert ? t.infoTitle : (t.alertOutline ? `${t.label} — needs your attention` : t.label)"
          :aria-label="t.infoAlert ? t.infoTitle : t.label"
          @click="railClick(t.name)"
        >
          <q-icon :name="t.icon" size="22px" class="my-stuff-rail__icon" />
          <span class="my-stuff-rail__label">{{ t.label }}</span>
          <!-- Alert badge slot. Real signals (indexing failure,
               unverified summary, mismatched patient, etc.) get
               wired in during the later UI phase. -->
          <q-badge
            v-if="t.alertCount > 0"
            class="my-stuff-rail__badge"
            color="warning"
            text-color="black"
            :label="t.alertCount > 9 ? '9+' : String(t.alertCount)"
            floating
          />
          <!-- Blue triangle: informational "something is waiting for you"
               (e.g. Groups has an invitation, request, or new message).
               Distinct from the orange `has-attention` outline. -->
          <span
            v-if="t.infoAlert"
            class="my-stuff-rail__info-triangle"
            aria-hidden="true"
          ></span>
          <q-tooltip v-if="t.infoAlert" anchor="center right" self="center left">
            {{ t.infoTitle }}
          </q-tooltip>
        </button>

        <!-- Spacer pushes the user / sign-out group to the bottom of
             the rail. Flex column with margin-top: auto on the next
             element accomplishes the same thing more reliably than
             a separate spacer div. -->

        <!-- User + sign-out, anchored to the bottom of the rail.
             Labeled mode: "User: <id>" caption + full SIGN OUT
             button. Icons-only mode: just an exit-door icon button
             with the userId in the tooltip. Replaces the per-chat
             toolbar group that used to live in ChatInterface.vue's
             header. -->
        <div class="my-stuff-rail__user">
          <div v-if="railLabeled" class="my-stuff-rail__user-id" :title="props.userId">
            {{ props.userId || 'Guest' }}
          </div>
          <button
            type="button"
            class="my-stuff-rail__signout"
            :class="{ 'my-stuff-rail__signout--icon': !railLabeled }"
            @click="handleSignOutClick"
            :aria-label="`Sign out ${props.userId || ''}`.trim()"
            :title="railLabeled ? 'Sign out' : `Sign out (${props.userId || 'Guest'})`"
          >
            <q-icon name="logout" size="20px" />
            <span v-if="railLabeled" class="my-stuff-rail__signout-label">SIGN OUT</span>
          </button>
        </div>
      </nav>

      <!-- Content panel: replaces the chat area entirely when open.
           v-show (not v-if) so tab state, scroll, polling timers,
           computed deps survive open/close round-trips.
           v1.4.33: the "My Stuff" header row and the inline q-tabs
           strip were removed — the rail on the left now serves as
           the section header / nav, and the rail's "Workbook"
           label + active-tab highlight tell the user where they
           are. -->
      <div v-show="isOpen" class="my-stuff-content">
    <q-card style="width: 100%; height: 100%; display: flex; flex-direction: column; box-shadow: none; border-radius: 0;">
      <q-card-section style="flex: 1; overflow-y: auto; min-height: 0;">
        <q-tab-panels v-model="currentTab" animated>
          <!-- Saved Files Tab -->
          <q-tab-panel name="files">
            <!-- SAFETY: Patient mismatch banner. Renders when the
                 deterministic identity scan finds files describing
                 more than one patient (DOB mismatch). A MAIA account
                 is for ONE patient — see Documentation/Clinical.md
                 §… Records for two patients in one KB produces a
                 Patient Summary that mixes them: clinically unsafe.
                 Banner is persistent, red, and surfaces a per-file
                 list so the user can remove the offending files. -->
            <div
              v-if="patientConsistency && patientConsistency.consistent === false"
              class="q-mb-md q-pa-md"
              style="border: 2px solid #b71c1c; border-radius: 6px; background: #ffebee;"
            >
              <div class="row items-center q-mb-sm">
                <q-icon name="warning" color="negative" size="28px" class="q-mr-sm" />
                <div class="text-h6 text-negative">SAFETY: Records for multiple patients detected</div>
              </div>
              <div class="text-body2 q-mb-sm">
                A MAIA account is for <strong>one patient</strong>. The files below appear to
                describe more than one person. Remove the mismatched files before continuing
                — leaving them in the knowledge base will produce a Patient Summary that
                mixes data from multiple patients, which is clinically unsafe.
              </div>
              <div class="q-mb-sm">
                <strong>Primary patient (kept):</strong>
                {{ patientConsistency.primary?.name || '(name not parseable)' }}
                <span v-if="patientConsistency.primary?.dobIso">
                  — DOB {{ patientConsistency.primary.dobIso }}
                </span>
                ({{ patientConsistency.primary?.fromFiles?.length || 0 }} file(s))
              </div>
              <div class="q-mb-xs"><strong>Mismatched files (remove these):</strong></div>
              <ul class="q-mt-none q-mb-sm" style="margin-left: 1.5em;">
                <li v-for="m in patientConsistency.mismatches" :key="m.fileName">
                  <code>{{ m.fileName }}</code>
                  <span v-if="m.name || m.dobIso" class="text-grey-8">
                    — {{ m.name || '(name not parseable)' }}<span v-if="m.dobIso">, DOB {{ m.dobIso }}</span>
                  </span>
                </li>
              </ul>
              <div class="text-caption text-grey-8">
                {{ patientConsistency.reason }}
              </div>
              <q-btn
                flat dense color="negative"
                icon="refresh"
                label="Re-check"
                class="q-mt-sm"
                @click="checkPatientConsistency"
              />
            </div>

            <div v-if="loadingFiles" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading files...</div>
            </div>

            <div v-else-if="filesError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ filesError }}</div>
              <q-btn label="Retry" color="primary" @click="loadFiles" class="q-mt-md" />
            </div>

            <div
              v-else-if="userFiles.length === 0 && props.rehydrationActive && rehydrationQueue.length > 0"
              class="q-mt-md"
            >
              <div
                class="q-mb-md q-pa-md"
                style="border: 1px dashed #b0bec5; border-radius: 6px; background: #f7f9fb;"
              >
                <div class="text-subtitle2">Restore your files</div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  Please upload each file to rebuild your Spaces folder.
                </div>
                <div class="q-mt-sm text-body2">
                  Next file: <strong>{{ rehydrationCurrent ? (rehydrationCurrent.fileName || rehydrationCurrent.bucketKey) : 'All done' }}</strong>
                  <span v-if="rehydrationStep === 0" class="q-ml-sm text-grey-7">(initial file)</span>
                </div>
                <div class="q-mt-md">
                  <q-btn
                    color="primary"
                    label="Upload Next File"
                    :disable="rehydrationUploading || !rehydrationCurrent"
                    @click="triggerRehydrationInput"
                  />
                  <span class="q-ml-sm text-caption text-grey-7">
                    {{ rehydrationCompleted.size }} / {{ rehydrationQueue.length }} uploaded
                  </span>
                </div>
                <div v-if="rehydrationDisplayList.length > 0" class="q-mt-sm">
                  <div
                    v-for="entry in rehydrationDisplayList"
                    :key="entry.bucketKey || entry.fileName"
                    class="row items-center q-mt-xs"
                  >
                    <div class="col text-caption text-grey-7">
                      {{ entry.displayName }}
                    </div>
                    <q-chip
                      v-if="!entry.restored"
                      color="red-5"
                      text-color="white"
                      size="sm"
                    >
                      Please re-import this file
                    </q-chip>
                    <q-chip
                      v-else
                      color="green-5"
                      text-color="white"
                      size="sm"
                    >
                      Restored
                    </q-chip>
                    <span class="q-ml-sm text-caption text-grey-7">
                      {{ entry.chipStatus || 'unknown' }}
                    </span>
                  </div>
                </div>
                <input
                  ref="rehydrationInput"
                  type="file"
                  style="display: none;"
                  @change="handleRehydrationFileSelected"
                />
              </div>
            </div>

            <div v-else-if="userFiles.length === 0" class="text-center q-pa-md text-grey">
              <q-icon name="folder_open" size="3em" />
              <div class="q-mt-sm">No files found</div>
            </div>

            <div v-else class="q-mt-md">
              <div
                v-if="props.rehydrationActive && rehydrationQueue.length > 0"
                class="q-mb-md q-pa-md"
                style="border: 1px dashed #b0bec5; border-radius: 6px; background: #f7f9fb;"
              >
                <div class="text-subtitle2">Restore your files</div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  Please upload each file to rebuild your Spaces folder.
                </div>
                <div class="q-mt-sm text-body2">
                  Next file: <strong>{{ rehydrationCurrent ? (rehydrationCurrent.fileName || rehydrationCurrent.bucketKey) : 'All done' }}</strong>
                  <span v-if="rehydrationStep === 0" class="q-ml-sm text-grey-7">(initial file)</span>
                </div>
                <div class="q-mt-md">
                  <q-btn
                    color="primary"
                    label="Upload Next File"
                    :disable="rehydrationUploading || !rehydrationCurrent"
                    @click="triggerRehydrationInput"
                  />
                  <span class="q-ml-sm text-caption text-grey-7">
                    {{ rehydrationCompleted.size }} / {{ rehydrationQueue.length }} uploaded
                  </span>
                </div>
                <div v-if="rehydrationDisplayList.length > 0" class="q-mt-sm">
                  <div
                    v-for="entry in rehydrationDisplayList"
                    :key="entry.bucketKey || entry.fileName"
                    class="row items-center q-mt-xs"
                  >
                    <div class="col text-caption text-grey-7">
                      {{ entry.displayName }}
                    </div>
                    <q-chip
                      v-if="!entry.restored"
                      color="red-5"
                      text-color="white"
                      size="sm"
                    >
                      Please re-import this file
                    </q-chip>
                    <q-chip
                      v-else
                      color="green-5"
                      text-color="white"
                      size="sm"
                    >
                      Restored
                    </q-chip>
                    <span class="q-ml-sm text-caption text-grey-7">
                      {{ entry.chipStatus || 'unknown' }}
                    </span>
                  </div>
                </div>
                <input
                  ref="rehydrationInput"
                  type="file"
                  style="display: none;"
                  @change="handleRehydrationFileSelected"
                />
              </div>
              <q-list>
                <q-item v-for="file in userFiles" :key="file.bucketKey" class="q-pa-md">
                  <q-item-section avatar>
                    <div class="row items-center q-gutter-xs">
                      <q-checkbox
                        :model-value="file.inKnowledgeBase"
                        @click.stop="toggleKbCheckbox(file)"
                        :disable="updatingFiles.has(file.bucketKey) || indexingKB"
                        :color="file.pendingKbAdd ? 'grey-6' : 'primary'"
                      />
                      <q-spinner
                        v-if="updatingFiles.has(file.bucketKey)"
                        size="20px"
                        color="primary"
                      />
                    </div>
                  </q-item-section>
                  <q-item-section>
                    <q-item-label 
                      class="cursor-pointer text-primary"
                      @click="viewFileInPdfViewer(file)"
                    >
                      {{ file.fileName }}
                      <q-chip
                        v-if="file.isAppleHealth"
                        color="blue-6"
                        text-color="white"
                        size="sm"
                        dense
                        class="q-ml-xs"
                      >
                        Apple Health
                      </q-chip>
                    </q-item-label>
                    <q-item-label caption>
                      {{ formatFileSize(file.fileSize) }} • Uploaded {{ formatDate(file.uploadedAt) }}
                      <span v-if="updatingFiles.has(file.bucketKey)" class="q-ml-sm text-primary">
                        Moving file...
                      </span>
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side>
                    <div class="row items-center q-gutter-xs">
                      <!-- Pending from wizard - show gray "To be added and indexed" -->
                      <q-chip
                        v-if="file.pendingKbAdd"
                        color="grey-4"
                        text-color="grey-8"
                        size="sm"
                      >
                        To be added and indexed
                      </q-chip>
                      <!-- Not in KB - show amber "Add to Knowledge Base" -->
                      <q-chip
                        v-else-if="!file.inKnowledgeBase"
                        color="amber"
                        text-color="white"
                        size="sm"
                        :clickable="!cancellingIndexing"
                        :disable="cancellingIndexing"
                        @click="!cancellingIndexing && (file.inKnowledgeBase = true, onCheckboxChange(file))"
                      >
                        Add to Knowledge Base
                      </q-chip>
                      <!-- In KB, indexing active on server - show "Indexing in progress" -->
                      <q-chip
                        v-else-if="file.inKnowledgeBase && !isFileIndexed(file.bucketKey) && (indexingKB || kbIndexingActiveOnServer)"
                        color="blue"
                        text-color="white"
                        size="sm"
                      >
                        <q-spinner size="12px" class="q-mr-xs" />
                        Indexing in progress
                      </q-chip>
                      <!-- In KB but not indexed and no indexing active - show warning "To be added and indexed" -->
                      <q-chip
                        v-else-if="file.inKnowledgeBase && !isFileIndexed(file.bucketKey)"
                        color="orange"
                        text-color="white"
                        size="sm"
                        :clickable="!cancellingIndexing"
                        :disable="cancellingIndexing"
                        @click="!cancellingIndexing && (file.inKnowledgeBase = false, onCheckboxChange(file))"
                      >
                        To be added and indexed
                      </q-chip>
                      <!-- In KB and indexed - show primary "Indexed in Knowledge Base" -->
                      <q-chip
                        v-else
                        color="primary"
                        text-color="white"
                        size="sm"
                        :clickable="!cancellingIndexing"
                        :disable="cancellingIndexing"
                        @click="!cancellingIndexing && (file.inKnowledgeBase = false, onCheckboxChange(file))"
                      >
                        Indexed in Knowledge Base
                      </q-chip>
                      <q-btn
                        flat
                        round
                        dense
                        icon="delete"
                        color="negative"
                        :disable="cancellingIndexing"
                        @click="confirmDeleteFile(file)"
                        title="Delete file"
                      />
                    </div>
                  </q-item-section>
                </q-item>
              </q-list>

              <div
                v-if="kbSummaryTokens !== null && kbSummaryFiles !== null"
                class="q-mt-sm text-caption text-grey-7"
              >
                Your Private AI current knowledge base has a total {{ formatNumber(kbSummaryTokens) }} tokens from
                {{ formatNumber(kbSummaryFiles) }} indexed files
                <span v-if="kbDataSourceCount !== null">
                  ({{ formatNumber(kbDataSourceCount) }} data sources)
                </span>.
              </div>
              
              <div v-if="kbNeedsUpdate || hasCheckboxChanges || kbIndexingOutOfSync || hasPendingKbAdds" class="q-mt-md q-pt-md" style="border-top: 1px solid #e0e0e0;">
                <div v-if="kbNeedsUpdate || hasCheckboxChanges || hasPendingKbAdds" class="q-mb-md text-body2 text-amber-9">
                  You have changed the files to be indexed into your knowledge base. Click "Update and Index KB" when ready.
                </div>
                <div v-else-if="kbIndexingOutOfSync && !hasCheckboxChanges && !hasPendingKbAdds" class="q-mb-md text-body2 text-amber-9">
                  You have changed the files to be indexed into your knowledge base. Click to index when ready.
                </div>
                <div class="row q-gutter-sm">
                <q-btn
                  label="Update and Index KB"
                  color="primary"
                  @click="updateAndIndexKB"
                    :disable="indexingKB || cancellingIndexing"
                  :loading="indexingKB"
                />
                </div>
              </div>
              
              <!-- Phase 1: Moving files -->
              <div v-if="indexingKB && indexingStatus.phase === 'moving'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Moving files to knowledge base folder...' }}</div>
              </div>

              <!-- Phase 2: KB Setup -->
              <div v-if="indexingKB && indexingStatus.phase === 'kb_setup'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Setting up knowledge base...' }}</div>
                <div v-if="indexingStatus.kb" class="text-caption text-grey-7 q-mt-xs">KB: {{ indexingStatus.kb }}</div>
              </div>

              <!-- Phase 3: Indexing Started -->
              <div v-if="indexingKB && indexingStatus.phase === 'indexing_started'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Indexing job started...' }}</div>
                <div class="text-caption text-grey-7 q-mt-xs">This may take several minutes</div>
                <q-btn
                  flat
                  dense
                  color="negative"
                  label="Cancel Indexing"
                  class="q-mt-sm"
                  @click="cancelIndexingAndRestore"
                />
              </div>

              <!-- Phase 4: Indexing In Progress -->
              <div v-if="indexingKB && indexingStatus.phase === 'indexing'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress 
                  :value="indexingStatus.progress || 0" 
                  color="primary" 
                  animated
                  class="q-mb-sm"
                />
                <div class="text-body2">Indexing in progress...</div>
                <div v-if="indexingStatus.message" class="text-caption text-grey-7 q-mt-xs">
                  {{ indexingStatus.message }}
                </div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  <span v-if="indexingStatus.kb">KB: {{ indexingStatus.kb }} • </span>
                  <span v-if="indexingElapsedTime">Time: {{ indexingElapsedTime }} • </span>
                  Files: {{ indexingStatus.filesIndexed || 0 }} • 
                  Tokens: {{ indexingStatus.tokens || 'Calculating...' }}
                </div>
                <div class="text-caption text-grey-6 q-mt-xs">
                  This may take up to 60 minutes.
                </div>
                <q-btn
                  flat
                  dense
                  color="negative"
                  label="Cancel Indexing"
                  class="q-mt-sm"
                  @click="cancelIndexingAndRestore"
                />
              </div>

              <!-- Phase 5: Complete -->
              <div v-if="indexingKB && indexingStatus.phase === 'complete'" class="q-mt-md q-pa-md" style="background-color: #e8f5e9; border-radius: 4px; border: 1px solid #4caf50;">
                <div class="text-body2 text-positive">
                  ✅ {{ indexingStatus.message || 'Knowledge base indexed successfully!' }}
                </div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  <span v-if="indexingStatus.kb">KB: {{ indexingStatus.kb }} • </span>
                  Tokens: {{ indexingStatus.tokens }} • 
                  Files: {{ indexingStatus.filesIndexed }}
                </div>
              </div>

              <!-- Phase 6: Error -->
              <div v-if="indexingKB && indexingStatus.phase === 'error'" class="q-mt-md q-pa-md" style="background-color: #ffebee; border-radius: 4px; border: 1px solid #f44336;">
                <div class="text-body2 text-negative">
                  {{ indexingStatus.error || 'Indexing failed' }}
                </div>
                <div v-if="indexingStatus.kb" class="text-caption text-grey-7 q-mt-xs">KB: {{ indexingStatus.kb }}</div>
              </div>

              <!-- Cancelling state -->
              <div v-if="cancellingIndexing" class="q-mt-md q-pa-md" style="background-color: #fff3e0; border-radius: 4px; border: 1px solid #ff9800;">
                <q-linear-progress indeterminate color="orange" class="q-mb-sm" />
                <div class="text-body2">Cancelling indexing and restoring files to archived folder...</div>
                <div class="text-caption text-grey-7 q-mt-xs">Please wait. File changes are disabled until cancel completes.</div>
              </div>
            </div>
          </q-tab-panel>

          <!-- My AI Agent Tab -->
          <q-tab-panel name="agent">
            <!-- Sub-tabs: Primary (GPT) and Secondary (Kimi) -->
            <q-tabs
              v-model="activeAgentProfile"
              dense
              align="left"
              class="text-grey-7 q-mb-md"
              active-color="primary"
              indicator-color="primary"
            >
              <q-tab name="default" :label="profileLabel('default')" />
              <q-tab name="gpt" :label="profileLabel('gpt')" />
            </q-tabs>

            <!-- Primary agent tab -->
            <template v-if="activeAgentProfile === 'default'">
              <div class="row items-center justify-between q-mb-md">
                <div class="text-h6">Agent Instructions</div>
                <q-btn
                  label="EDIT"
                  color="primary"
                  @click="editMode = !editMode"
                  :icon="editMode ? 'close' : 'edit'"
                />
              </div>

              <!-- Deep link Private AI access switch -->
              <div class="row items-center justify-center q-mb-md">
                <q-toggle
                  v-model="allowDeepLinkPrivateAI"
                  label="Deep link users can chat with your Private AI"
                  color="primary"
                  :loading="savingDeepLinkSetting"
                  @update:model-value="saveDeepLinkPrivateAISetting"
                />
              </div>

              <div v-if="loadingAgent" class="text-center q-pa-md">
                <q-spinner size="2em" />
                <div class="q-mt-sm">Loading agent...</div>
              </div>

              <div v-else-if="agentError" class="text-center q-pa-md">
                <q-icon name="error" color="negative" size="40px" />
                <div class="text-negative q-mt-sm">{{ agentError }}</div>
                <q-btn label="Retry" color="primary" @click="loadAgent" class="q-mt-md" />
              </div>

              <div v-else-if="agentInstructions">
                <div v-if="editMode" class="q-mb-md">
                  <q-input
                    v-model="editedInstructions"
                    type="textarea"
                    rows="15"
                    outlined
                    autofocus
                  />
                  <div class="q-mt-md">
                    <q-btn label="Save" color="primary" @click="saveInstructions" :loading="savingInstructions" />
                    <q-btn label="Cancel" flat @click="cancelEdit" class="q-ml-sm" />
                  </div>
                </div>

                <div v-else>
                  <div class="q-mb-md">
                    <vue-markdown :source="agentInstructions" />
                  </div>
                </div>

              <!-- Agent Knowledge Bases (per this agent) -->
              <div v-if="agentKbs.length" class="q-mt-lg" style="border-top: 1px solid #e0e0e0; padding-top: 16px;">
                <div class="text-h6 q-mb-md">Knowledge Bases</div>

                <div class="text-caption text-grey-7 q-mb-sm">
                  Tick a box to stage a change, then press <strong>Index Now</strong> to apply.
                  Changes here do not affect your Saved Files.
                </div>

                <div
                  v-for="kb in agentKbs"
                  :key="kb.key"
                  class="row items-center q-mb-sm"
                >
                  <div class="col-auto q-pr-sm">
                    <q-checkbox v-model="pendingKb[kb.key]" :disable="kbApplyBusy" />
                  </div>
                  <div class="col">
                    <div class="text-weight-medium">{{ kb.label }}</div>
                    <div class="text-caption text-grey-7 q-mt-xs">
                      {{ kb.name || (kb.key === 'kb2' ? 'Created on first connect' : '—') }}
                    </div>
                  </div>
                  <div class="col-auto">
                    <q-chip
                      :color="kb.connected ? 'green' : 'grey-5'"
                      text-color="white"
                      :label="kb.connected ? 'Connected' : 'Not Connected'"
                      dense
                    />
                    <q-badge
                      v-if="pendingKb[kb.key] !== kb.connected"
                      color="amber-8"
                      class="q-ml-xs"
                      :label="pendingKb[kb.key] ? 'will connect' : 'will disconnect'"
                    />
                  </div>
                </div>

                <div v-if="kbHasStagedChanges" class="q-mt-sm">
                  <q-btn
                    label="Index Now"
                    color="primary"
                    icon="bolt"
                    :loading="kbApplyBusy"
                    :disable="kbApplyBusy"
                    @click="applyKbChanges"
                  />
                  <span class="text-caption text-grey-7 q-ml-sm">
                    Applies the staged connect/disconnect and indexes if needed.
                  </span>
                </div>
                <!-- Inline KB-2 indexing progress (own job; does not
                     affect Saved Files) -->
                <div
                  v-if="kb2Index.active || kb2Index.done || kb2Index.failed"
                  class="q-mt-sm q-pa-sm"
                  style="background:#f5f5f5;border-radius:4px"
                >
                  <template v-if="kb2Index.active">
                    <q-linear-progress indeterminate color="primary" class="q-mb-xs" />
                    <div class="text-caption text-grey-8">
                      Indexing alternate KB —
                      {{ Number(kb2Index.tokens).toLocaleString() }} tokens,
                      {{ kb2Index.filesIndexed }} file(s),
                      {{ Math.floor(kb2Index.elapsedSec / 60) }}m {{ kb2Index.elapsedSec % 60 }}s
                      (5–60 min typical)
                    </div>
                  </template>
                  <div v-else-if="kb2Index.done" class="text-caption text-green-8">
                    ✓ Alternate KB indexed — {{ Number(kb2Index.tokens).toLocaleString() }} tokens,
                    {{ kb2Index.filesIndexed }} file(s)
                  </div>
                  <div v-else class="text-caption text-negative">
                    Alternate KB indexing failed — try Index Now again.
                  </div>
                </div>
              </div>

              <!-- Indexed-files detail for the primary KB -->
              <div v-if="kbInfo" class="q-mt-md">

                <div class="q-mt-md">
                  <div class="text-caption text-grey-7 q-mb-xs">Indexed Files:</div>
                  <div 
                    v-if="indexedFileNames.length === 0"
                    class="text-caption text-grey-5"
                  >
                    No files indexed yet
                  </div>
                  <q-list
                    v-else
                    dense
                    :class="{ 'text-grey-5': !kbInfo.connected }"
                  >
                    <q-item
                      v-for="(fileName, index) in indexedFileNames"
                      :key="index"
                      dense
                    >
                      <q-item-section>
                        <q-item-label 
                          :class="{ 'text-grey-5': !kbInfo.connected }"
                          class="text-caption"
                        >
                          {{ fileName }}
                        </q-item-label>
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
              </div>

              <div v-else-if="!loadingAgent" class="q-mt-lg text-center text-grey-7">
                <div class="text-caption">No knowledge base configured</div>
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="smart_toy" size="3em" />
              <div class="q-mt-sm">No agent found</div>
            </div>
            </template>

            <!-- Secondary agent tab -->
            <template v-else-if="activeAgentProfile === 'gpt'">
              <!-- Deploy UI (when secondary not yet deployed) -->
              <template v-if="!agentInstructions && !loadingAgent">
                <div class="row items-center justify-between q-mb-md">
                  <div class="text-h6">{{ profileLabel('gpt') }}</div>
                </div>

                <div v-if="secondaryDeployStatus === 'ready'" class="q-mb-md">
                  <q-banner class="bg-green-1 text-green-9 rounded-borders">
                    <template v-slot:avatar><q-icon name="check_circle" color="green" /></template>
                    Agent deployed and ready.
                  </q-banner>
                </div>

                <div v-else-if="secondaryDeployStatus === 'deploying'" class="q-mb-md">
                  <q-banner class="bg-blue-1 text-blue-9 rounded-borders">
                    <template v-slot:avatar><q-spinner color="primary" size="1.2em" /></template>
                    <div>
                      Deploying...
                      <strong>{{ secondaryDeployElapsed }}s</strong>
                      <span class="text-grey-7"> / 3 min max</span>
                    </div>
                    <div v-if="secondaryDeploySteps.length" class="q-mt-sm">
                      <div v-for="(step, i) in secondaryDeploySteps" :key="i" class="text-caption" :class="step.ok === false ? 'text-red' : step.ok ? 'text-green-8' : 'text-grey-7'">
                        {{ step.label }}{{ step.elapsed ? ` (${step.elapsed}s)` : '' }}
                        <span v-if="step.ok === false"> — failed: {{ step.error }}</span>
                      </div>
                    </div>
                  </q-banner>
                  <q-btn
                    flat
                    label="Cancel"
                    color="red"
                    icon="cancel"
                    class="q-mt-sm"
                    @click="cancelSecondaryDeploy"
                  />
                </div>

                <div v-else-if="secondaryDeployStatus === 'failed'" class="q-mb-md">
                  <q-banner class="bg-red-1 text-red-9 rounded-borders">
                    <template v-slot:avatar><q-icon name="error" color="red" /></template>
                    Deployment failed{{ secondaryDeployError ? ': ' + secondaryDeployError : '' }}
                  </q-banner>
                </div>

                <div v-else-if="secondaryDeployStatus === 'timeout'" class="q-mb-md">
                  <q-banner class="bg-orange-1 text-orange-9 rounded-borders">
                    <template v-slot:avatar><q-icon name="schedule" color="orange" /></template>
                    Deployment timed out after 3 minutes.
                  </q-banner>
                </div>

                <div v-if="secondaryDeployStatus === 'idle' || secondaryDeployStatus === 'failed' || secondaryDeployStatus === 'timeout'" class="q-mb-md">
                  <q-btn
                    :label="`Deploy ${profileLabel('gpt')}`"
                    color="primary"
                    icon="rocket_launch"
                    @click="startSecondaryDeploy"
                  />
                </div>
              </template>

              <!-- Full agent controls (same as primary, shown when deployed) -->
              <template v-else>
                <div class="row items-center justify-between q-mb-md">
                  <div class="text-h6">Agent Instructions</div>
                  <q-btn
                    label="EDIT"
                    color="primary"
                    @click="editMode = !editMode"
                    :icon="editMode ? 'close' : 'edit'"
                  />
                </div>

                <div class="row items-center justify-center q-mb-md">
                  <q-toggle
                    v-model="allowDeepLinkPrivateAI"
                    label="Deep link users can chat with your Private AI"
                    color="primary"
                    :loading="savingDeepLinkSetting"
                    @update:model-value="saveDeepLinkPrivateAISetting"
                  />
                </div>

                <div v-if="loadingAgent" class="text-center q-pa-md">
                  <q-spinner size="2em" />
                  <div class="q-mt-sm">Loading agent...</div>
                </div>

                <div v-else-if="agentError" class="text-center q-pa-md">
                  <q-icon name="error" color="negative" size="40px" />
                  <div class="text-negative q-mt-sm">{{ agentError }}</div>
                  <q-btn label="Retry" color="primary" @click="loadAgent" class="q-mt-md" />
                </div>

                <div v-else-if="agentInstructions">
                  <div v-if="editMode" class="q-mb-md">
                    <q-input
                      v-model="editedInstructions"
                      type="textarea"
                      rows="15"
                      outlined
                      autofocus
                    />
                    <div class="q-mt-md">
                      <q-btn label="Save" color="primary" @click="saveInstructions" :loading="savingInstructions" />
                      <q-btn label="Cancel" flat @click="cancelEdit" class="q-ml-sm" />
                    </div>
                  </div>

                  <div v-else>
                    <div class="q-mb-md">
                      <vue-markdown :source="agentInstructions" />
                    </div>
                  </div>

                <div v-if="agentKbs.length" class="q-mt-lg" style="border-top: 1px solid #e0e0e0; padding-top: 16px;">
                  <div class="text-h6 q-mb-md">Knowledge Bases</div>

                  <div class="text-caption text-grey-7 q-mb-sm">
                    Tick a box to stage a change, then press <strong>Index Now</strong> to apply.
                    Changes here do not affect your Saved Files.
                  </div>

                  <div
                    v-for="kb in agentKbs"
                    :key="kb.key"
                    class="row items-center q-mb-sm"
                  >
                    <div class="col-auto q-pr-sm">
                      <q-checkbox v-model="pendingKb[kb.key]" :disable="kbApplyBusy" />
                    </div>
                    <div class="col">
                      <div class="text-weight-medium">{{ kb.label }}</div>
                      <div class="text-caption text-grey-7 q-mt-xs">
                        {{ kb.name || (kb.key === 'kb2' ? 'Created on first connect' : '—') }}
                      </div>
                    </div>
                    <div class="col-auto">
                      <q-chip
                        :color="kb.connected ? 'green' : 'grey-5'"
                        text-color="white"
                        :label="kb.connected ? 'Connected' : 'Not Connected'"
                        dense
                      />
                      <q-badge
                        v-if="pendingKb[kb.key] !== kb.connected"
                        color="amber-8"
                        class="q-ml-xs"
                        :label="pendingKb[kb.key] ? 'will connect' : 'will disconnect'"
                      />
                    </div>
                  </div>

                  <div v-if="kbHasStagedChanges" class="q-mt-sm">
                    <q-btn
                      label="Index Now"
                      color="primary"
                      icon="bolt"
                      :loading="kbApplyBusy"
                      :disable="kbApplyBusy"
                      @click="applyKbChanges"
                    />
                    <span class="text-caption text-grey-7 q-ml-sm">
                      Applies the staged connect/disconnect and indexes if needed.
                    </span>
                  </div>
                </div>

                <div v-if="kbInfo" class="q-mt-md">
                  <div class="q-mt-md">
                    <div class="text-caption text-grey-7 q-mb-xs">Indexed Files:</div>
                    <div
                      v-if="indexedFileNames.length === 0"
                      class="text-caption text-grey-5"
                    >
                      No files indexed yet
                    </div>
                    <q-list
                      v-else
                      dense
                      :class="{ 'text-grey-5': !kbInfo.connected }"
                    >
                      <q-item
                        v-for="(fileName, index) in indexedFileNames"
                        :key="index"
                        dense
                      >
                        <q-item-section>
                          <q-item-label
                            :class="{ 'text-grey-5': !kbInfo.connected }"
                            class="text-caption"
                          >
                            {{ fileName }}
                          </q-item-label>
                        </q-item-section>
                      </q-item>
                    </q-list>
                  </div>
                </div>

                <div v-else-if="!loadingAgent" class="q-mt-lg text-center text-grey-7">
                  <div class="text-caption">No knowledge base configured</div>
                </div>
              </div>

              <div v-else class="text-center q-pa-md text-grey">
                <q-icon name="smart_toy" size="3em" />
                <div class="q-mt-sm">No agent found</div>
              </div>
              </template>
            </template>
          </q-tab-panel>

          <!-- Saved Chats Tab -->
          <q-tab-panel name="chats">
            <div v-if="loadingChats" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading chats...</div>
            </div>

            <div v-else-if="chatsError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ chatsError }}</div>
              <q-btn label="Retry" color="primary" @click="loadSharedChats" class="q-mt-md" />
            </div>

            <div v-else-if="sharedChats.length === 0" class="text-center q-pa-md text-grey">
              <q-icon name="chat" size="3em" />
              <div class="q-mt-sm">No shared group chats found</div>
            </div>

            <div v-else class="q-mt-md">
              <q-list>
                <q-item
                  v-for="chat in sortedSharedChats"
                  :key="chat._id"
                  clickable
                  class="q-pa-md q-mb-sm"
                  style="border: 1px solid #e0e0e0; border-radius: 8px;"
                  @click="selectChat(chat)"
                >
                  <q-item-section>
                    <q-item-label class="text-weight-medium">
                      {{ formatDate(chat.updatedAt || chat.createdAt) }}
                    </q-item-label>
                    <q-item-label caption class="q-mt-xs">
                      {{ getLastQueryDescription(chat) }}
                    </q-item-label>
                    <q-item-label caption class="q-mt-xs">
                      Group Participants: {{ getGroupParticipants(chat) }}
                    </q-item-label>
                    <q-item-label v-if="chat.shareId" caption class="q-mt-xs text-primary">
                      <q-icon name="link" size="xs" />
                      Deep link: /chat/{{ chat.shareId }}
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side @click.stop>
                    <div class="row items-center q-gutter-xs">
                      <q-btn
                        flat
                        round
                        dense
                        icon="link"
                        color="primary"
                        @click="copyChatLink(chat)"
                        title="Copy deep link"
                      />
                      <q-btn
                        flat
                        round
                        dense
                        icon="delete"
                        color="negative"
                        @click="confirmDeleteChat(chat)"
                        title="Delete chat"
                      />
                    </div>
                  </q-item-section>
                </q-item>
              </q-list>
            </div>
          </q-tab-panel>

          <!-- My Lists Tab -->
          <q-tab-panel name="lists">
            <Lists
              ref="listsComponentRef"
              :userId="userId"
              :profile-labels="agentProfileLabelsMap"
              :draft-ps-meds="draftPsMeds"
              :user-files="userFiles"
              @back-to-chat="closeDialog"
              @show-patient-summary="handleShowPatientSummary"
              @current-medications-saved="handleCurrentMedicationsSaved"
              @medications-offered="handleMedicationsOffered"
            />
          </q-tab-panel>

          <!-- Groups Tab (Groups & AS feature — Documentation/Groups.md §7.4) -->
          <q-tab-panel name="groups" class="q-pa-none" style="display: flex; flex-direction: column; height: 100%;">
            <GroupsPanel :userId="userId" style="flex: 1; min-height: 0;" @open-thread="(t) => emit('open-peer-thread', t)" @group-joined="emit('group-joined')" />
          </q-tab-panel>

          <q-tab-panel name="policies" class="q-pa-none" style="overflow-y: auto;">
            <PoliciesPanel :userId="userId" @group-joined="emit('group-joined')" />
          </q-tab-panel>

          <!-- Privacy Filter Tab -->
          <q-tab-panel name="privacy">
            <!-- Filter Current Chat Button -->
            <div class="q-pa-md" style="border-bottom: 1px solid #eee;">
              <q-btn
                label="Filter Current Chat"
                color="primary"
                icon="filter_alt"
                :disable="!privacyFilterMapping.length || !props.originalMessages || props.originalMessages.length === 0"
                @click="filterCurrentChat"
                class="full-width"
              />
              <div v-if="!privacyFilterMapping.length" class="text-caption text-grey q-mt-xs text-center">
                No pseudonym mapping available
              </div>
              <div v-else-if="!props.originalMessages || props.originalMessages.length === 0" class="text-caption text-grey q-mt-xs text-center">
                No chat messages available
              </div>
            </div>

            <div v-if="loadingPrivacyFilter" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Analyzing chat for names...</div>
            </div>

            <div v-else-if="privacyFilterError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ privacyFilterError }}</div>
              <q-btn label="Retry" color="primary" @click="loadPrivacyFilter" class="q-mt-md" />
            </div>

            <div v-else-if="privacyFilterMapping.length > 0" class="q-pa-md">
              <div class="text-h6 q-mb-md">Privacy Filter - Name Pseudonymization</div>
              
              <div v-if="loadingRandomNames" class="text-center q-pa-md">
                <q-spinner size="1.5em" />
                <div class="q-mt-sm">Generating pseudonyms...</div>
              </div>
              
              <div v-else class="q-mt-md">
                <div class="text-body2 text-grey q-mb-sm">
                  Showing {{ privacyFilterMapping.length }} name{{ privacyFilterMapping.length !== 1 ? 's' : '' }} in pseudonym mapping
                </div>
                <q-table
                  :rows="privacyFilterMapping"
                  :columns="[
                    { name: 'original', label: 'Original Name', field: 'original', align: 'left' },
                    { name: 'pseudonym', label: 'Pseudonym', field: 'pseudonym', align: 'left' }
                  ]"
                  row-key="original"
                  flat
                  bordered
                  :rows-per-page-options="[0]"
                  hide-pagination
                />
              </div>
            </div>

            <div v-else-if="privacyFilterResponse" class="q-pa-md">
              <div class="text-h6 q-mb-md">Privacy Filter - Name Pseudonymization</div>
              <div class="text-body2 text-grey q-mb-md">No pseudonym mapping available. Original response:</div>
              <div class="privacy-filter-response">
                <vue-markdown :source="privacyFilterResponse" />
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="person_off" size="3em" />
              <div class="q-mt-sm">No mapping available</div>
            </div>
          </q-tab-panel>

          <!-- Patient Diary Tab -->
          <q-tab-panel name="diary" class="q-pa-none" style="display: flex; flex-direction: column; height: 100%;">
            <div v-if="loadingDiary" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading diary...</div>
            </div>

            <div v-else-if="diaryError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ diaryError }}</div>
              <q-btn label="Retry" color="primary" @click="loadDiary" class="q-mt-md" />
            </div>

            <div v-else style="display: flex; flex-direction: column; height: 100%;">
              <!-- Diary Messages Area -->
              <div 
                ref="diaryMessagesRef" 
                class="q-pa-md" 
                style="flex: 1; overflow-y: auto; min-height: 0;"
              >
                <div v-if="diaryEntries.length === 0" class="text-center q-pa-md text-grey">
                  <q-icon name="book" size="3em" />
                  <div class="q-mt-sm">No diary entries yet</div>
                  <div class="text-caption q-mt-xs">Start writing your first entry below</div>
                </div>

                <template v-for="bubble in diaryBubbles" :key="bubble.entries[bubble.entries.length - 1]?.id || bubble.lastDateTime">
                  <div class="q-mb-md" style="position: relative;">
                    <div class="row items-center justify-between q-mb-xs">
                      <div class="text-caption text-grey-7">
                        {{ formatDiaryDateTime(bubble.lastDateTime) }}
                      </div>
                      <div class="row q-gutter-xs">
                        <q-btn
                          flat
                          dense
                          size="sm"
                          icon="send"
                          color="primary"
                          label="Post diary to chat"
                          @click="postBubbleToChat(bubble)"
                        />
                        <q-btn
                          flat
                          dense
                          round
                          size="sm"
                          icon="delete"
                          color="negative"
                          @click="deleteBubble(bubble)"
                          title="Delete bubble"
                        />
                      </div>
                    </div>
                    <div 
                      class="q-pa-md bg-blue-1 rounded-borders"
                      style="display: inline-block; max-width: 80%;"
                      :class="{ 'opacity-60': bubble.closed }"
                    >
                      <div
                        v-for="(entry, entryIdx) in bubble.entries" 
                        :key="entry.id || entryIdx"
                        class="text-body1"
                        :class="{ 'q-mb-sm': entryIdx < bubble.entries.length - 1 }"
                        style="white-space: pre-wrap;"
                      >
                        <span class="text-grey-7 text-caption">{{ formatDiaryTime(entry.dateTime) }}</span> {{ entry.message }}
                      </div>
                    </div>
                  </div>
                </template>
              </div>

              <!-- Text Input Area -->
              <div class="q-pa-md" style="flex-shrink: 0; border-top: 1px solid #eee;">
                <q-input
                  v-model="diaryInputText"
                  type="textarea"
                  autogrow
                  filled
                  placeholder="Write your diary entry..."
                  :disable="isSavingDiary"
                  @keydown.enter.ctrl="addDiaryEntry"
                  @keydown.enter.meta="addDiaryEntry"
                  class="q-mb-sm"
                />
                <div class="row justify-end">
                  <q-btn
                    label="Add Entry"
                    color="primary"
                    icon="send"
                    @click="addDiaryEntry"
                    :loading="isSavingDiary"
                    :disable="!diaryInputText.trim() || isSavingDiary"
                  />
                </div>
              </div>
            </div>
          </q-tab-panel>

          <!-- SHARED REFERENCES Tab -->
          <q-tab-panel name="references" class="q-pa-none" style="display: flex; flex-direction: column; height: 100%;">
            <div v-if="loadingReferences" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading references...</div>
            </div>

            <div v-else-if="referencesError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ referencesError }}</div>
              <q-btn label="Retry" color="primary" @click="loadReferences" class="q-mt-md" />
            </div>

            <div v-else style="display: flex; flex-direction: column; height: 100%;">
              <!-- Header with paperclip -->
              <div class="q-pa-md" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
                <div class="row items-center justify-between">
                  <div class="text-h6">Shared References</div>
                  <q-btn 
                    flat 
                    dense 
                    round 
                    icon="attach_file" 
                    class="text-grey-6" 
                    @click="triggerReferenceFileInput"
                    title="Upload reference file"
                  >
                    <q-tooltip>Upload a reference file</q-tooltip>
                  </q-btn>
                  <input
                    ref="referenceFileInput"
                    type="file"
                    style="display: none"
                    @change="handleReferenceFileSelect"
                    accept=".pdf,.txt,.md"
                  />
                </div>
              </div>

              <!-- References List -->
              <div class="q-pa-md" style="flex: 1; overflow-y: auto; min-height: 0;">
                <div v-if="referenceFiles.length === 0" class="text-center q-pa-md text-grey">
                  <q-icon name="link" size="3em" />
                  <div class="q-mt-sm">No reference files yet</div>
                  <div class="text-caption q-mt-xs">Use the paperclip icon to upload reference files</div>
                </div>

                <q-list v-else>
                  <q-item 
                    v-for="file in referenceFiles" 
                    :key="file.bucketKey" 
                    class="q-pa-md"
                    clickable
                    @click="showAddReferenceToChatDialog(file)"
                  >
                    <q-item-section avatar>
                      <q-icon name="description" size="2em" color="primary" />
                    </q-item-section>
                    <q-item-section>
                      <q-item-label>{{ file.fileName }}</q-item-label>
                      <q-item-label caption>
                        {{ formatFileSize(file.fileSize) }} • Uploaded {{ formatDate(file.uploadedAt) }}
                      </q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <div class="row items-center q-gutter-xs">
                        <q-btn 
                          flat 
                          dense 
                          round 
                          size="sm"
                          icon="visibility" 
                          color="primary"
                          @click.stop="viewReferenceFile(file)"
                          title="View file"
                        />
                        <q-btn 
                          flat 
                          dense 
                          round 
                          size="sm"
                          icon="delete" 
                          color="negative"
                          @click.stop="deleteReferenceFile(file)"
                          title="Delete file"
                        />
                      </div>
                    </q-item-section>
                  </q-item>
                </q-list>
              </div>
            </div>
          </q-tab-panel>

          <!-- Patient Summary Tab -->
          <q-tab-panel name="summary">
            <!-- Sub-tabs: Summary itself + per-agent Patient Summary
                 instruction prompt editors. -->
            <q-tabs
              v-model="summarySubTab"
              dense
              align="left"
              class="text-grey-7 q-mb-md"
              active-color="primary"
              indicator-color="primary"
            >
              <q-tab name="summary" label="Summary" />
              <q-tab name="inst-default" :label="instrTabLabel('default')" />
              <q-tab name="inst-gpt" :label="instrTabLabel('gpt')" />
            </q-tabs>

            <!-- Instruction editor (per-agent Patient Summary prompt override) -->
            <template v-if="summarySubTab === 'inst-default'">
              <div class="text-caption text-grey-7 q-mb-sm">
                Per-agent Patient Summary instructions. Saved to your account;
                used by this agent when generating a Patient Summary. The
                <code>{patientIdentity}</code>, <code>{currentMedications}</code>,
                <code>{encounters}</code>, and <code>{allergies}</code>
                placeholders are substituted with the patient's data at request
                time. Leave empty to revert to the default.
              </div>
              <div v-if="summaryInstr.loading" class="text-center q-pa-md">
                <q-spinner size="1.5em" color="primary" />
              </div>
              <template v-else>
                <q-input
                  v-model="summaryInstr.text"
                  type="textarea"
                  autogrow
                  filled
                  class="bg-grey-1 rounded-borders"
                  placeholder="(using the default Patient Summary prompt)"
                />
                <div class="row items-center q-gutter-sm q-mt-sm">
                  <q-btn
                    label="Save"
                    color="primary"
                    icon="save"
                    :loading="summaryInstr.saving"
                    :disable="summaryInstr.saving"
                    @click="savePatientSummaryInstructions"
                  />
                  <q-btn
                    flat
                    label="Reset to default"
                    color="grey-7"
                    icon="restart_alt"
                    :disable="summaryInstr.saving"
                    @click="resetPatientSummaryInstructions"
                  />
                  <q-space />
                  <div v-if="summaryInstr.status" class="text-caption text-grey-7">{{ summaryInstr.status }}</div>
                </div>
              </template>
            </template>

            <!-- Secondary AI: no custom instructions -->
            <template v-else-if="summarySubTab === 'inst-gpt'">
              <div class="text-body2 text-grey-7 q-pa-md bg-grey-1 rounded-borders">
                The secondary AI uses its built-in capabilities with no custom Patient Summary instructions.
                Patient Summaries are generated by the Primary AI only.
              </div>
            </template>

            <!-- Summary sub-tab: existing content unchanged. -->
            <template v-else>
            <!-- Dual-AI Summary Chooser: appears above the saved summary when
                 the user clicks "Request New Summary". Both Private AIs run
                 the same prompt in parallel; the user picks one. -->
            <div v-if="loadingPair || summaryPair" class="q-mb-md">
              <div v-if="loadingPair" class="text-center q-pa-md bg-grey-1 rounded-borders">
                <q-spinner size="1.5em" color="primary" />
                <div class="q-mt-sm text-body2">Generating from both Private AIs (this can take 1–5 minutes)…</div>
              </div>
              <template v-else-if="summaryPair">
                <div class="text-caption text-grey-7 q-mb-sm">
                  Compare the two summaries and choose one. The unchosen one is discarded.
                </div>
                <q-card v-for="(cand, idx) in [summaryPair.default, summaryPair.gpt]" :key="idx" flat bordered class="q-mb-sm">
                  <q-card-section v-if="cand">
                    <div class="row items-center justify-between q-mb-sm">
                      <div>
                        <div class="text-subtitle2">
                          {{ profileLabel(cand.profileKey || (idx === 0 ? 'default' : 'gpt')) }}
                          <span v-if="cand.ok" class="text-caption text-grey-7 q-ml-sm">
                            {{ cand.model }}{{ cand.generationSeconds ? ` · ${cand.generationSeconds}s` : '' }}
                          </span>
                        </div>
                      </div>
                      <q-btn
                        v-if="cand.ok && cand.text"
                        label="Choose this one"
                        color="primary"
                        dense
                        @click="chooseSummaryCandidate(cand.text)"
                      />
                    </div>
                    <div
                      v-if="cand.ok && cand.text"
                      class="text-body2 q-pa-sm bg-grey-1 rounded-borders"
                      v-html="renderPsHtml(cand.text)"
                      @click="handlePsCitationClick"
                    ></div>
                    <div v-else class="text-caption text-orange-9">
                      Not available: {{ cand.reason || cand.error || 'unknown' }}.
                      <span v-if="cand.reason === 'AGENT_NOT_READY' || cand.reason === 'GPT_NOT_READY'">
                        The agent is still deploying — try Refresh in a minute.
                      </span>
                    </div>
                  </q-card-section>
                </q-card>
                <div class="row q-gutter-sm q-mt-sm">
                  <q-btn flat label="Discard both" color="grey-7" @click="dismissSummaryPair" />
                  <q-space />
                  <q-btn flat label="Regenerate" color="primary" icon="refresh" @click="handleRequestNewSummary" />
                </div>
              </template>
            </div>

            <div v-if="loadingSummary" class="q-pa-md">
              <div v-if="generatingSummary" class="q-mb-sm">
                <div class="text-subtitle2 q-mb-sm">Generating Patient Summary... {{ summaryElapsed }}s</div>
                <div v-for="(step, i) in summaryGenerationSteps" :key="i" class="row items-center q-mb-xs" style="font-size: 0.85rem;">
                  <q-icon
                    :name="i < summaryGenerationStep ? 'check_circle' : (i === summaryGenerationStep ? 'hourglass_top' : 'radio_button_unchecked')"
                    :color="i < summaryGenerationStep ? 'positive' : (i === summaryGenerationStep ? 'primary' : 'grey-5')"
                    size="18px"
                    class="q-mr-sm"
                  />
                  <span :class="i <= summaryGenerationStep ? 'text-dark' : 'text-grey-5'">{{ step.label }}</span>
                  <q-spinner v-if="i === summaryGenerationStep" size="14px" color="primary" class="q-ml-sm" />
                </div>
              </div>
              <div v-else class="text-center">
                <q-spinner size="2em" />
                <div class="q-mt-sm">Loading patient summary...</div>
              </div>
            </div>

            <div v-else-if="summaryError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ summaryError }}</div>
              <q-btn label="Retry" color="primary" @click="loadPatientSummary" class="q-mt-md" />
            </div>

            <div v-else-if="patientSummary" class="q-mt-md">
              <!-- SAFETY: identity-parse failure banner. Renders when
                   the stored summary contains the sentinel string
                   "Patient name not parseable from records" emitted by
                   the server when no file in the KB yielded a
                   parseable Name/DOB. Tells the user the summary is
                   trustworthy except for the patient name itself. -->
              <div
                v-if="identityParseFailed"
                class="q-mb-md q-pa-md"
                style="border: 2px solid #f57c00; border-radius: 6px; background: #fff8e1;"
              >
                <div class="row items-center q-mb-xs">
                  <q-icon name="warning" color="warning" size="24px" class="q-mr-sm" />
                  <div class="text-subtitle1 text-warning">Patient identity could not be parsed</div>
                </div>
                <div class="text-body2">
                  The Patient Summary below is correct in its clinical content, but the
                  patient's <strong>name was not parseable</strong> from any of your source
                  PDF headers (Apple Health / Epic / etc.). The summary deliberately reads
                  "Patient name not parseable from records" instead of guessing — guessing
                  would risk grabbing a spouse, emergency-contact, or referring-physician
                  name from inside the records. To fix: add a clearer source PDF whose
                  header contains the patient's name and DOB in a recognizable format,
                  then regenerate.
                </div>
              </div>
              <div class="row items-center justify-between q-gutter-sm q-mb-sm">
                <div class="text-caption text-grey-7">
                  <!-- Patient summary editing -->
              </div>
                <div class="row q-gutter-sm">
                  <q-btn
                    v-if="showSummaryAttention && !isEditingSummaryTab"
                    outline
                    label="Verify"
                    color="primary"
                    icon="verified"
                    :class="{ 'verify-highlight': showSummaryAttention }"
                    @click="handleVerifySummaryTab"
                  />
                  <q-btn
                    v-if="!isEditingSummaryTab"
                    outline
                    label="Edit"
                    color="primary"
                    icon="edit"
                    :class="{ 'verify-highlight': showSummaryAttention }"
                    @click="startSummaryEdit"
                  />
                  <q-btn
                    v-else
                    flat
                    label="Cancel"
                    color="grey-8"
                    icon="close"
                    @click="cancelSummaryEdit"
                    :disable="isSavingSummary"
                  />
                </div>
              </div>

              <div v-if="isEditingSummaryTab">
                <q-input
                  v-model="summaryEditText"
                  type="textarea"
                  autogrow
                  filled
                  class="bg-grey-1 rounded-borders"
                  :disable="isSavingSummary"
                  placeholder="Enter patient summary..."
                />
              </div>
              <div
                v-else
                class="text-body1 q-pa-md bg-grey-1 rounded-borders"
                v-html="patientSummaryHtml"
                @click="handlePsCitationClick"
              ></div>

              <div class="row items-center q-gutter-sm q-mt-md">
                <q-btn
                  v-if="isEditingSummaryTab"
                  label="Save"
                  color="primary"
                  icon="save"
                  @click="saveSummaryFromTab"
                  :loading="isSavingSummary"
                  :disable="isSavingSummary"
                />
                <!-- Buttons for non-current summaries -->
                <template v-for="(summary, index) in patientSummaries" :key="index">
                  <q-btn
                    v-if="!summary.isCurrent && !isEditingSummaryTab"
                    outline
                    :label="`SUMMARY ${getTimeAgo(summary.updatedAt || summary.createdAt)} ago`"
                    color="grey-7"
                    size="sm"
                    @click="swapSummary(index)"
                    :disable="isSavingSummary"
                  />
                </template>
                <q-space />
                <q-btn
                  v-if="showSummaryAttention && !isEditingSummaryTab"
                  outline
                  label="Verify"
                  color="primary"
                  icon="verified"
                  :class="{ 'verify-highlight': showSummaryAttention }"
                  @click="handleVerifySummaryTab"
                />
                <q-btn
                  v-if="!isEditingSummaryTab"
                  outline
                  label="Edit"
                  color="primary"
                  icon="edit"
                  :class="{ 'verify-highlight': showSummaryAttention }"
                  @click="startSummaryEdit"
                />
                <q-btn
                  label="Request New Summary"
                  color="primary"
                  @click="handleRequestNewSummary"
                  icon="refresh"
                  :disable="isEditingSummaryTab || isSavingSummary || loadingSummary"
                  :loading="loadingSummary"
                />
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="description" size="3em" />
              <div class="q-mt-sm">No patient summary found</div>
              <div class="q-mt-md">
                <q-btn
                  label="Request Summary"
                  color="primary"
                  @click="handleRequestNewSummary"
                  icon="add"
                  :loading="loadingSummary"
                />
              </div>
            </div>
            </template>
          </q-tab-panel>
        </q-tab-panels>
      </q-card-section>
    </q-card>
      </div>
    </aside>

    <!-- Local Folder Delete Reminder -->
    <q-dialog v-model="showLocalFolderDeleteReminder" persistent>
      <q-card style="min-width: 400px; max-width: 520px">
        <q-card-section>
          <div class="text-h6">
            <q-icon name="info" color="primary" class="q-mr-sm" />
            Local Folder
          </div>
        </q-card-section>
        <q-card-section class="q-pt-none text-body2">
          <b>{{ deletedFileName }}</b> has been deleted from MAIA but may still
          exist in your local MAIA folder. If you don't also delete it from
          the local folder, it could be restored the next time you run the
          setup wizard.
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            label="I UNDERSTAND"
            color="primary"
            @click="showLocalFolderDeleteReminder = false"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- (The "Medications Mismatch" modal that previously offered an
         I UNDERSTAND / UPDATE choice was removed: when verified Current
         Medications exist and disagree with the Patient Summary, the
         summary is auto-patched in place. See checkMedicationsConsistency
         + handleMedsMismatchUpdate.) -->

    <!-- PDF Viewer Modal -->
    <PdfViewerModal
      v-model="showPdfViewer"
      :file="viewingFile"
      :initial-page="pdfViewerInitialPage"
    />

    <!-- Text/Markdown Viewer Modal -->
    <TextViewerModal
      v-model="showTextViewer"
      :file="viewingFile"
    />

    <!-- Patient Summary Available Modal (used both before and after generation) -->
    <q-dialog v-model="showSummaryAvailableModal" persistent>
      <q-card style="min-width: 400px; max-width: 600px;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">
            {{ isSummaryModalBeforeGeneration ? 'Replace Existing Summary?' : 'New Patient Summary Available' }}
          </div>
        </q-card-section>

        <q-card-section>
          <div class="text-body1">
            {{ isSummaryModalBeforeGeneration 
              ? 'A patient summary already exists. Generating a new summary will replace the current one. Do you want to continue?'
              : 'A new patient summary has been generated based on your updated knowledge base.' }}
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <q-btn 
            flat 
            :label="isSummaryModalBeforeGeneration 
              ? 'CANCEL' 
              : (patientSummary ? 'KEEP SAVED SUMMARY' : 'CLOSE MyStuff')" 
            color="grey-8" 
            @click="handleCloseSummaryModal"
          />
          <q-btn 
            flat 
            label="REPLACE SUMMARY" 
            color="primary" 
            @click="isSummaryModalBeforeGeneration ? handleConfirmReplaceSummary() : handleSaveSummary()"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Patient Summary View Modal -->
    <q-dialog v-model="showSummaryViewModal" persistent>
      <q-card style="min-width: 600px; max-width: 900px; max-height: 80vh;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Patient Summary</div>
          <q-space />
          <q-btn icon="close" flat round dense @click="handleCloseWithoutSaving" />
        </q-card-section>

        <q-card-section style="max-height: 60vh; overflow-y: auto;">
          <div
            v-if="!editingSummary"
            class="text-body2"
            v-html="renderPsHtml(summaryViewText)"
            @click="handlePsCitationClick"
          ></div>
          <q-input
            v-else
            v-model="summaryViewText"
            type="textarea"
            autofocus
            rows="20"
            filled
            style="width: 100%;"
          />
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <q-btn
            v-if="showSummaryAttention && !editingSummary"
            outline
            label="VERIFY"
            color="primary"
            icon="verified"
            :class="{ 'verify-highlight': showSummaryAttention }"
            @click="handleVerifySummaryTab"
          />
          <q-btn 
            flat 
            label="CLOSE WITHOUT SAVING" 
            color="grey-8" 
            @click="handleCloseWithoutSaving"
          />
          <q-btn 
            v-if="editingSummary"
            label="SAVE" 
            color="primary" 
            @click="handleSaveEditedSummary"
          />
          <q-btn 
            v-else
            label="EDIT" 
            color="primary" 
            @click="handleEditSummary"
            :class="{ 'verify-highlight': showSummaryAttention }"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Replace Summary Dialog (when new summary is created and all slots are full) -->
    <q-dialog v-model="showReplaceSummaryDialog" persistent>
      <q-card style="min-width: 800px; max-width: 1200px; max-height: 90vh;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">New Patient Summary Generated</div>
        </q-card-section>

        <q-card-section style="max-height: 60vh; overflow-y: auto;">
          <div class="text-body1 q-mb-md">
            A new patient summary has been generated. Choose which summary to replace:
          </div>
          <div
            class="text-body2 q-pa-md bg-grey-1 rounded-borders"
            v-html="renderPsHtml(newSummaryToReplace)"
            @click="handlePsCitationClick"
          ></div>
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <!-- Buttons for each existing summary (oldest to newest) -->
          <template v-for="(summary, index) in patientSummaries" :key="index">
            <q-btn 
              flat 
              :label="`Replace ${getTimeAgo(summary.updatedAt || summary.createdAt)} ago summary`"
              color="primary" 
              @click="handleReplaceSummaryByIndex(index)"
            />
          </template>
          <q-btn
            flat
            label="Close without saving"
            color="grey-8"
            @click="showReplaceSummaryDialog = false; newSummaryToReplace = ''"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Update Patient Summary after meds change dialog -->
    <q-dialog v-model="showUpdateSummaryDialog" persistent>
      <q-card style="min-width: 380px; max-width: 500px;">
        <q-card-section>
          <div class="text-h6">Update Patient Summary?</div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <div class="text-body1">
            Your Current Medications have changed. Would you like to regenerate the Patient Summary to reflect the update?
          </div>
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
          <q-btn flat label="Not Now" color="grey-8" @click="showUpdateSummaryDialog = false" />
          <q-btn flat label="Update Summary" color="primary" @click="handleAcceptUpdateSummary" />
        </q-card-actions>
      </q-card>
    </q-dialog>

  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import VueMarkdown from 'vue-markdown-render';
import MarkdownIt from 'markdown-it';
import PdfViewerModal from './PdfViewerModal.vue';
import TextViewerModal from './TextViewerModal.vue';
import Lists from './Lists.vue';
import GroupsPanel from './GroupsPanel.vue';
import PoliciesPanel from './PoliciesPanel.vue';
import { useQuasar } from 'quasar';
import { deleteChatById } from '../utils/chatApi';
import { processFileNCitations } from '../utils/fileNCitations';

// Local markdown-it with html: true so the <a class="page-link"> anchors
// emitted by processFileNCitations survive rendering. vue-markdown-render
// has html: false by default which would strip them.
const psMarkdown = new MarkdownIt({ html: true, linkify: false, breaks: false });

interface UserFile {
  fileName: string;
  bucketKey: string;
  fileSize: number;
  uploadedAt: string;
  inKnowledgeBase: boolean;
  pendingKbAdd?: boolean;
  fileType?: string;
  isAppleHealth?: boolean;
}

interface SavedChat {
  _id: string;
  type: string;
  shareId: string;
  currentUser: string;
  patientOwner?: string;
  chatHistory: any[];
  uploadedFiles: any[];
  createdAt: string;
  updatedAt: string;
  isShared?: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  name?: string;
  authorId?: string;
  authorLabel?: string;
  authorType?: 'user' | 'assistant';
  providerKey?: string;
}

interface Props {
  modelValue: boolean;
  userId: string;
  initialTab?: string;
  messages?: Message[];
  originalMessages?: Message[]; // Original unfiltered messages for privacy filtering
  rehydrationFiles?: Array<{ fileName?: string; bucketKey?: string; fileSize?: number; uploadedAt?: string }>;
  rehydrationActive?: boolean;
  // True whenever the parent considers a wizard run to be in
  // progress — wizard dialog open, or wizardFlowPhase not 'done'.
  // Drives the yellow rotating ring around the Setup Wizard icon
  // at the top of the rail. Optional + defaults to false so the
  // ring is off unless the parent explicitly opts in.
  wizardActive?: boolean;
  // True when the server has no saved currentMedications — the
  // user has neither verified nor edited them. Drives the yellow
  // outline on the My Lists rail icon AND the navigation gate on
  // Patient Summary ("must verify meds first").
  medsNeedsVerify?: boolean;
  draftPsMeds?: string[];
  showClosePrompt?: boolean;
  savedChatCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'files',
  messages: () => [],
  originalMessages: () => [],
  wizardActive: false,
  medsNeedsVerify: false,
  draftPsMeds: () => [],
  showClosePrompt: false,
  savedChatCount: 0,
});

const emit = defineEmits<{
  'group-joined': [];
  'index-now-triggered': [];
  'update:modelValue': [value: boolean];
  'chat-selected': [chat: SavedChat];
  'indexing-started': [data: { jobId: string; phase: string }];
  'indexing-status-update': [data: { jobId: string; phase: string; tokens: string; filesIndexed: number; progress: number }];
  'indexing-finished': [data: { jobId: string; phase: string; error?: string }];
  'files-archived': [archivedFiles: string[]]; // Emit bucketKeys of archived files
  'messages-filtered': [messages: Message[], nameMapping?: Array<{ original: string; pseudonym: string }>]; // Emit filtered messages with pseudonyms
  'diary-posted': [content: string]; // Emit diary content to add to chat
  'reference-file-added': [file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string; isReference: boolean }]; // Emit reference file to add to chat
  'current-medications-saved': [data: { value: string; edited: boolean; source?: string }];
  'medications-offered': [data: {
    lines: number;
    source: 'apple-health' | 'patient-summary' | 'manual' | 'user-doc';
    outcome: 'success' | 'ai-refusal' | 'ai-error' | 'ai-empty' | 'summary-empty' | 'no-source' | 'agent-not-ready' | 'extract-error';
    detail?: string;
  }];
  'patient-summary-saved': [data: { userId: string; summary?: string }];
  'patient-summary-verified': [data: { userId: string }];
  'rehydration-complete': [payload: { hasInitialFile: boolean }];
  'rehydration-file-removed': [payload: { bucketKey?: string; fileName?: string }];
  'show-patient-summary': [];
  'file-added-to-kb': [data: { fileName: string; bucketKey: string }];
  'tab-opened': [tab: string];
  // Sign-out moved from the chat toolbar into the rail's bottom
  // section. The parent (ChatInterface.vue) still owns the actual
  // sign-out logic (snapshot save, session destroy, App-level
  // state reset); we just forward the user's click.
  'sign-out-requested': [];
  // Setup Wizard launcher moved to the top of the rail in
  // v1.4.34. Parent still owns the wizard state machine
  // (showAgentSetupDialog, wizardDismissed, wizardFlowPhase);
  // we just forward the user's click.
  'wizard-requested': [];
  'open-peer-thread': [payload: { groupId: string; peerId: string; alias: string | null; groupName: string }];
  'provisioning-event': [data: Record<string, any>];
}>();

// Handle show patient summary from Lists component — regenerate summary with updated medications
const handleShowPatientSummary = () => {
  loadingSummary.value = true;          // show spinner immediately
  currentTab.value = 'summary';         // switch tab (watcher will call loadPatientSummary, but we override below)
  pendingSummaryRegeneration.value = true; // flag so the tab watcher skips its loadPatientSummary
  requestNewSummary();                  // regenerate with latest medications
  emit('show-patient-summary');
};

// (Prior client-side auto-regen refs removed — server-side
// splice in GET /api/patient-summary handles the "verified meds
// don't match PS Current Medications section" case without any
// AI call.)

const handleCurrentMedicationsSaved = (payload: { value: string; edited: boolean; changed?: boolean; source?: string; verified?: boolean }) => {
  emit('current-medications-saved', payload);
  if (payload.changed && payload.verified && !props.wizardActive) {
    // Only show "Update Patient Summary?" outside the wizard — during the wizard,
    // ChatInterface patches the draft PS directly via update-summary-meds.
    showUpdateSummaryDialog.value = true;
    summaryNeedsVerify.value = true;
  } else if (payload.verified) {
    summaryNeedsVerify.value = true;
  }
};

const handleAcceptUpdateSummary = () => {
  showUpdateSummaryDialog.value = false;
  currentTab.value = 'summary';
  loadingSummary.value = true;
  pendingSummaryRegeneration.value = true;
  requestNewSummary();
};

const handleMedicationsOffered = (payload: {
  lines: number;
  source: 'apple-health' | 'patient-summary' | 'manual' | 'user-doc';
  outcome: 'success' | 'ai-refusal' | 'ai-error' | 'ai-empty' | 'summary-empty' | 'no-source' | 'agent-not-ready' | 'extract-error';
  detail?: string;
}) => {
  emit('medications-offered', payload);
};

const isOpen = ref(props.modelValue);

// "When the Workbook sidebar is expanded, show the last open tab
// or Saved Files if the last open is unknown."
// Persist the user's last-opened tab to localStorage so it survives
// page reloads and across sessions. On mount: prefer the parent's
// explicit `initialTab` prop (programmatic open requests a specific
// tab — wizard, restore, summary-ready prompt), else the persisted
// value, else 'files'.
const TAB_LS_KEY = 'maia.workbookLastTab';
const VALID_TABS = new Set(['files', 'agent', 'chats', 'summary', 'lists', 'privacy', 'diary', 'references']);
const readPersistedTab = (): string | null => {
  try {
    const v = window.localStorage.getItem(TAB_LS_KEY);
    return v && VALID_TABS.has(v) ? v : null;
  } catch { return null; }
};
const initialMountTab = props.initialTab || readPersistedTab() || 'files';
const currentTab = ref<string>(initialMountTab);
// Track the most recently APPLIED initialTab from the parent so the
// modelValue watcher can distinguish a "parent passed a new
// initialTab — honor it" from "parent reopened with the same stale
// initialTab — keep the user's last choice." Without this, a user
// who picks Agent from the rail loses their selection every time
// the panel reopens (parent's `myStuffInitialTab` defaults to
// 'files' and would otherwise overwrite).
let lastAppliedInitialTab: string = props.initialTab || '';
// Persist on change so reloads preserve the last-opened tab.
watch(currentTab, (v) => {
  try { window.localStorage.setItem(TAB_LS_KEY, v); } catch { /* ignore */ }
});

// Rail tab manifest. Mirrors the inline <q-tab> list in the template's
// expanded content panel exactly — the rail is just a vertical version
// of that same nav. Icons are reused so the user has a consistent
// visual mapping between the collapsed rail and the open header.
// `alertCount` is the placeholder slot for future alert badges
// (indexing failures, unverified Patient Summary, mismatched patient,
// etc.) — currently always 0; real signals get wired in the later UI-
// polish phase.
// `alertOutline` paints a yellow ring around the rail icon to
// indicate "this section needs your attention" — currently used
// for the two verification gates:
//   - Patient Summary: not verified or edited yet
//   - My Lists: Current Medications not verified or edited
// Yellow OUTLINE is distinct from the rotating yellow RING on the
// Setup Wizard icon (that one signals "wizard work in progress").
// --- Groups rail-icon alert (blue triangle) ---------------------------
// A small blue triangle on the Groups icon flags "something is waiting
// for you in Groups" without the user having to open the tab:
//   - a pending group invitation (localStorage, set by the invite URL)
//   - pending AS requests (first-contact from another member)
//   - new peer messages since you last opened the tab
// Distinct from the orange `alertOutline` ("needs verification"): this is
// informational/blue. Cheap to poll: one GET /api/user-groups/alerts.
const INVITE_LS_KEY = 'maiaGroupInvite';
const GROUPS_SEEN_LS_KEY = 'maia.groupsMessagesSeen';
const groupsHasInvite = ref(false);
const groupsPendingRequests = ref(0);
const groupsMessageCount = ref(0);
const readGroupsSeen = (): number => {
  try { return parseInt(window.localStorage.getItem(GROUPS_SEEN_LS_KEY) || '0', 10) || 0; }
  catch { return 0; }
};
const groupsSeenMessages = ref<number>(readGroupsSeen());
const groupsNewMessages = computed(() =>
  Math.max(0, groupsMessageCount.value - groupsSeenMessages.value)
);
const groupsAlert = computed(() =>
  groupsHasInvite.value || groupsPendingRequests.value > 0 || groupsNewMessages.value > 0
);
const groupsAlertTitle = computed(() => {
  const parts: string[] = [];
  if (groupsHasInvite.value) parts.push('You have a group invitation');
  if (groupsPendingRequests.value > 0) {
    parts.push(`${groupsPendingRequests.value} group request${groupsPendingRequests.value > 1 ? 's' : ''} awaiting your response`);
  }
  if (groupsNewMessages.value > 0) {
    parts.push(`${groupsNewMessages.value} new group message${groupsNewMessages.value > 1 ? 's' : ''}`);
  }
  return parts.length ? `Groups — ${parts.join('; ')}` : 'Groups';
});
const refreshGroupsAlert = async () => {
  try { groupsHasInvite.value = !!window.localStorage.getItem(INVITE_LS_KEY); }
  catch { groupsHasInvite.value = false; }
  if (!props.userId) { groupsPendingRequests.value = 0; groupsMessageCount.value = 0; return; }
  try {
    const res = await fetch(`/api/user-groups/alerts?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success) {
        groupsPendingRequests.value = data.pendingRequests || 0;
        groupsMessageCount.value = data.messageCount || 0;
      }
    }
  } catch { /* network hiccup — leave last-known counts */ }
};
// Called when the user opens the Groups tab: mark current messages as
// seen (invite/requests clear on their own once acted on).
const markGroupsSeen = () => {
  groupsSeenMessages.value = groupsMessageCount.value;
  try { window.localStorage.setItem(GROUPS_SEEN_LS_KEY, String(groupsMessageCount.value)); } catch { /* ignore */ }
};
let groupsAlertTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  refreshGroupsAlert();
  groupsAlertTimer = setInterval(refreshGroupsAlert, 90000);
});
onUnmounted(() => { if (groupsAlertTimer) clearInterval(groupsAlertTimer); });
watch(() => props.userId, () => refreshGroupsAlert());

const railTabs = computed(() => [
  { name: 'files',      icon: 'description',  label: 'Saved Files',     alertCount: 0, alertOutline: false, infoAlert: false,             infoTitle: '' },
  { name: 'agent',      icon: 'smart_toy',    label: 'AI Agents',       alertCount: 0, alertOutline: false, infoAlert: false,             infoTitle: '' },
  { name: 'chats',      icon: 'chat',         label: 'Saved Chats',     alertCount: props.savedChatCount || 0, alertOutline: false, infoAlert: false, infoTitle: '' },
  { name: 'summary',    icon: 'description',  label: 'Patient Summary', alertCount: 0, alertOutline: summaryNeedsVerify.value, infoAlert: false, infoTitle: '' },
  { name: 'lists',      icon: 'list',         label: 'Lists',           alertCount: 0, alertOutline: !!props.medsNeedsVerify, infoAlert: false, infoTitle: '' },
  { name: 'groups',     icon: 'groups',       label: 'Groups',          alertCount: 0, alertOutline: false, infoAlert: groupsAlert.value, infoTitle: groupsAlertTitle.value },
  { name: 'policies',   icon: 'policy',       label: 'Sharing Policies', alertCount: 0, alertOutline: false, infoAlert: false,            infoTitle: '' },
  { name: 'privacy',    icon: 'privacy_tip',  label: 'Privacy Filter',  alertCount: 0, alertOutline: false, infoAlert: false,             infoTitle: '' },
  { name: 'diary',      icon: 'book',         label: 'Patient Diary',   alertCount: 0, alertOutline: false, infoAlert: false,             infoTitle: '' },
  { name: 'references', icon: 'link',         label: 'References',      alertCount: 0, alertOutline: false, infoAlert: false,             infoTitle: '' }
]);

// Click a rail icon: open the content panel AND jump to that section.
// If the panel is already open AND showing this tab, close it
// (toggle parity with the chevron header button).
const railClick = (name: string) => {
  // Note: the PS tab gate was removed in v1.4.89. The Patient
  // Summary may contain correct medications from the KB even when
  // Lists hasn't been verified. On PS verify, if meds differ,
  // the user is offered to sync PS meds → Lists.

  if (isOpen.value && currentTab.value === name) {
    closeDialog();
    return;
  }
  currentTab.value = name;
  // Consume any pending parent `initialTab` so the modelValue-open
  // watcher (which honors a *newly-supplied* initialTab) doesn't
  // clobber this explicit rail choice with a stale value. Without
  // this, opening the Workbook via the rail right after the wizard/
  // SEND flow (which leaves myStuffInitialTab='summary') would land
  // on Patient Summary on the first click and only reach the picked
  // tab on a second click. Programmatic opens set a NEW initialTab and
  // open directly (not via railClick), so they still take effect.
  lastAppliedInitialTab = props.initialTab || '';
  if (name === 'groups') markGroupsSeen();
  if (!isOpen.value) {
    isOpen.value = true;
    emit('update:modelValue', true);
  }
};

// Rail width preference: true = ~180px showing icons + labels
// (default), false = ~60px icons-only. Independent of `isOpen`;
// remembered for the session via localStorage so a user who
// prefers icons-only keeps it across reloads. Also surfaces the
// current rail width as a CSS variable on <body> so the chat
// container can use `padding-left: var(--my-stuff-rail-width)`
// to stay clear of the rail.
// Per-user key: the old browser-global key made every NEW user inherit
// whatever rail state the previous user left (usually collapsed after
// any amount of testing) — and a brand-new user has no idea what the
// Workbook sidebar even is yet. Labeled is the default until THIS user
// collapses it themselves.
const RAIL_LABEL_LS_KEY = () => `maia.myStuffRailLabeled.${props.userId || 'anon'}`;
const readRailLabeledPref = (): boolean => {
  try {
    const v = window.localStorage.getItem(RAIL_LABEL_LS_KEY());
    if (v === '0') return false;
    if (v === '1') return true;
  } catch { /* SSR / private mode */ }
  return true; // default: labeled
};
const railLabeled = ref<boolean>(readRailLabeledPref());

// The close prompt is words, not an icon — if the rail is collapsed to
// icons when it fires, expand it so "Close the Workbook to chat" is
// actually readable (the pulsing chevron alone is far too subtle for a
// user who doesn't know what the Workbook sidebar is yet).
watch(() => props.showClosePrompt, (on) => {
  if (on && !railLabeled.value) railLabeled.value = true;
});

const RAIL_WIDTH_LABELED = '180px';
const RAIL_WIDTH_ICONS   = '60px';

// Push the rail width into <body> as a CSS custom property so any
// app-level container can react. The chat layout in ChatInterface
// uses `padding-left: var(--my-stuff-rail-width, 0px)` to avoid
// being obscured by the rail.
const syncBodyRailWidth = () => {
  try {
    const w = railLabeled.value ? RAIL_WIDTH_LABELED : RAIL_WIDTH_ICONS;
    document.body.style.setProperty('--my-stuff-rail-width', w);
  } catch { /* non-DOM env */ }
};
syncBodyRailWidth();
watch(railLabeled, () => syncBodyRailWidth());

const toggleRailLabeled = () => {
  railLabeled.value = !railLabeled.value;
  try { window.localStorage.setItem(RAIL_LABEL_LS_KEY(), railLabeled.value ? '1' : '0'); } catch { /* ignore */ }
};

// Context-aware chevron at the top of the rail.
// - When the content panel is OPEN, the chevron's job is to
//   "collapse the Workbook" → close the panel → show the chat.
// - When the content panel is CLOSED, the chevron toggles the
//   rail width (labeled / icons-only). Icon direction hints at
//   the action.
const chevronIcon = computed(() => {
  if (isOpen.value) return 'chevron_left';        // collapse content
  return railLabeled.value ? 'chevron_left' : 'chevron_right';
});
const chevronAriaLabel = computed(() => {
  if (isOpen.value) return 'Collapse Workbook (show chat)';
  return railLabeled.value ? 'Collapse rail to icons' : 'Expand rail to labels';
});
const chevronTitle = computed(() => {
  if (isOpen.value) return 'Collapse (show chat)';
  return railLabeled.value ? 'Collapse rail' : 'Expand rail';
});
const chevronClick = () => {
  if (isOpen.value) {
    // Close the content panel — chat reappears underneath the
    // shrunken sidebar.
    closeDialog();
    return;
  }
  toggleRailLabeled();
};

const handleSignOutClick = () => {
  emit('sign-out-requested');
};

const handleWizardClick = () => {
  emit('wizard-requested');
};

// On unmount (e.g. sign-out → canAccessMyStuff false → component
// removed), clear the rail width so the chat reclaims full width.
onUnmounted(() => {
  try { document.body.style.removeProperty('--my-stuff-rail-width'); } catch { /* ignore */ }
});
const loadingFiles = ref(true);
const filesError = ref('');
const userFiles = ref<UserFile[]>([]);

/**
 * SAFETY: multi-patient detection. Holds the latest result of
 * `/api/files/verify-patient-consistency` so the Saved Files banner
 * can render when the user's file set describes more than one patient.
 * Null = not checked yet; populated object = check ran. `.consistent`
 * is true for the safe case, false to surface the SAFETY banner.
 */
const patientConsistency = ref<null | {
  consistent: boolean;
  primary: { name: string | null; dobIso: string | null; fromFiles?: string[] } | null;
  mismatches: Array<{ fileName: string; name: string | null; dobIso: string | null }>;
  reason: string;
}>(null);
const checkPatientConsistency = async () => {
  if (!props.userId) return;
  try {
    const r = await fetch(`/api/files/verify-patient-consistency?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' });
    if (!r.ok) return;
    const d = await r.json();
    patientConsistency.value = d?.success ? d : null;
  } catch (err) {
    console.warn('[MyStuff] patient-consistency check failed (non-fatal):', err);
  }
};
const updatingFiles = ref(new Set<string>());

const loadingAgent = ref(false);
const agentError = ref('');
const agentInstructions = ref('');
const editMode = ref(false);
const editedInstructions = ref('');
// Private AI agent profiles (GPT = 'default' [primary], Deepseek = 'gpt'
// [secondary] — profile keys kept for historical reasons; see auth.js). The
// My AI Agent tab shows one sub-tab per profile, each with its own
// system prompt + KB-attach toggle, all keyed by activeAgentProfile.
const agentProfilesList = ref<Array<{ key: string; label: string }>>([]);
const activeAgentProfile = ref<string>('default');
const savingInstructions = ref(false);

const agentProfileLabelsMap = computed(() => {
  const map: Record<string, string> = {};
  for (const p of agentProfilesList.value) map[p.key] = p.label;
  return map;
});

const profileLabel = (profileKey: string): string => {
  const prof = agentProfilesList.value.find(p => p.key === profileKey);
  if (prof) return prof.label;
  if (profileKey === 'default') return 'Private AI Primary (GPT)';
  return 'Private AI Secondary (Kimi)';
};
const instrTabLabel = (profileKey: string): string => {
  const label = profileLabel(profileKey);
  const short = label.replace(/^Private AI\s*/, '');
  return `Instructions for ${short}`;
};

// ── Secondary agent deployment ────────────────────────────────────
type DeployStep = { label: string; ok?: boolean; elapsed?: number; error?: string };
const secondaryDeployStatus = ref<'idle' | 'deploying' | 'ready' | 'failed' | 'timeout'>('idle');
const secondaryDeployElapsed = ref(0);
const secondaryDeployError = ref('');
const secondaryDeploySteps = ref<DeployStep[]>([]);
let secondaryDeployTimer: ReturnType<typeof setInterval> | null = null;
let secondaryDeployAbort: AbortController | null = null;
const SECONDARY_DEPLOY_TIMEOUT_MS = 180000; // 3 minutes

const addDeployStep = (label: string, ok?: boolean, elapsed?: number, error?: string) => {
  secondaryDeploySteps.value.push({ label, ok, elapsed, error });
  emit('provisioning-event', {
    event: 'secondary-deploy-step',
    step: label,
    ok: ok ?? null,
    elapsed: elapsed ?? null,
    error: error ?? null
  });
};

const cancelSecondaryDeploy = () => {
  if (secondaryDeployAbort) secondaryDeployAbort.abort();
  if (secondaryDeployTimer) { clearInterval(secondaryDeployTimer); secondaryDeployTimer = null; }
  secondaryDeployStatus.value = 'failed';
  secondaryDeployError.value = 'Cancelled by user';
  addDeployStep('Cancelled by user', false);
};

const startSecondaryDeploy = async () => {
  if (!props.userId) return;
  secondaryDeployStatus.value = 'deploying';
  secondaryDeployElapsed.value = 0;
  secondaryDeployError.value = '';
  secondaryDeploySteps.value = [];
  secondaryDeployAbort = new AbortController();
  const signal = secondaryDeployAbort.signal;
  const startedAt = Date.now();

  secondaryDeployTimer = setInterval(() => {
    secondaryDeployElapsed.value = Math.round((Date.now() - startedAt) / 1000);
    if (Date.now() - startedAt > SECONDARY_DEPLOY_TIMEOUT_MS) {
      if (secondaryDeployTimer) { clearInterval(secondaryDeployTimer); secondaryDeployTimer = null; }
      if (secondaryDeployAbort) secondaryDeployAbort.abort();
      secondaryDeployStatus.value = 'timeout';
      addDeployStep('Deployment timed out after 3 minutes', false);
      emit('provisioning-event', { event: 'secondary-provision-timeout', elapsedSeconds: secondaryDeployElapsed.value });
    }
  }, 1000);

  emit('provisioning-event', { event: 'secondary-provision-started' });

  try {
    // Step 1: Create the agent via ensure-secondary
    addDeployStep('Creating agent on DigitalOcean...');
    const t1 = Date.now();
    const createRes = await fetch('/api/agents/ensure-secondary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal,
      body: JSON.stringify({ userId: props.userId })
    });
    const createData = await createRes.json().catch(() => ({}));
    const createElapsed = Number(((Date.now() - t1) / 1000).toFixed(1));

    if (!createRes.ok || !createData.success) {
      throw new Error(createData.error || `HTTP ${createRes.status}`);
    }

    if (createData.ready) {
      addDeployStep('Agent created and ready', true, createElapsed);
      secondaryDeployStatus.value = 'ready';
      if (secondaryDeployTimer) { clearInterval(secondaryDeployTimer); secondaryDeployTimer = null; }
      emit('provisioning-event', { event: 'secondary-provision-ready', elapsedSeconds: createElapsed });
      return;
    }

    addDeployStep(`Agent created (${createData.status || 'deploying'})`, true, createElapsed);

    // Step 2: Poll until STATUS_RUNNING or timeout
    addDeployStep('Waiting for agent to reach STATUS_RUNNING...');
    const pollStart = Date.now();
    while (Date.now() - startedAt < SECONDARY_DEPLOY_TIMEOUT_MS) {
      if (signal.aborted) return;
      await new Promise(r => setTimeout(r, 5000));
      if (signal.aborted) return;

      try {
        const pollRes = await fetch('/api/agents/ensure-secondary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          signal,
          body: JSON.stringify({ userId: props.userId })
        });
        const pollData = await pollRes.json().catch(() => ({}));
        const pollElapsed = Number(((Date.now() - pollStart) / 1000).toFixed(1));
        const status = pollData.status || 'unknown';

        if (pollData.ready) {
          addDeployStep(`Agent STATUS_RUNNING`, true, pollElapsed);
          secondaryDeployStatus.value = 'ready';
          if (secondaryDeployTimer) { clearInterval(secondaryDeployTimer); secondaryDeployTimer = null; }
          emit('provisioning-event', {
            event: 'secondary-provision-ready',
            elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1))
          });
          return;
        }
        // Update the latest step with current status
        const lastStep = secondaryDeploySteps.value[secondaryDeploySteps.value.length - 1];
        if (lastStep && lastStep.label.startsWith('Waiting')) {
          lastStep.label = `Waiting for STATUS_RUNNING... (currently: ${status}, ${pollElapsed}s)`;
        }
      } catch (e: any) {
        if (e.name === 'AbortError') return;
      }
    }

    // If we get here, we timed out (the interval handler handles it)
  } catch (e: any) {
    if (e.name === 'AbortError') return;
    if (secondaryDeployTimer) { clearInterval(secondaryDeployTimer); secondaryDeployTimer = null; }
    secondaryDeployStatus.value = 'failed';
    secondaryDeployError.value = e.message || 'Unknown error';
    addDeployStep(`Error: ${e.message}`, false);
    emit('provisioning-event', { event: 'secondary-provision-failed', error: e.message });
  }
};

// Check if secondary is already deployed when switching to the tab
const checkSecondaryStatus = async () => {
  if (!props.userId || secondaryDeployStatus.value === 'deploying') return;
  try {
    const r = await fetch('/api/agents/ensure-secondary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, checkOnly: true })
    });
    const d = await r.json().catch(() => ({}));
    if (d.ready) {
      secondaryDeployStatus.value = 'ready';
    }
  } catch { /* ignore */ }
};

watch(activeAgentProfile, (tab) => {
  if (tab === 'gpt') void checkSecondaryStatus();
});

// Deep link Private AI access setting
const allowDeepLinkPrivateAI = ref(true); // Default to enabled
const savingDeepLinkSetting = ref(false);

// KB info for agent tab
const kbInfo = ref<{
  name: string;
  kbId: string;
  connected: boolean;
  indexedDataSourceCount?: number | null;
  lastIndexedAt?: string | null;
} | null>(null);
// Per-agent KB connection state (kb1 = primary/semantic,
// kb2 = alternate/hierarchical) for the active My-Agent sub-tab.
const agentKbs = ref<Array<{
  key: string; label: string; name: string | null;
  kbId: string | null; exists: boolean; connected: boolean;
}>>([]);
// Staged desired connection state per KB key (checkbox model). A
// change is only applied when the user presses "Index Now".
const pendingKb = ref<Record<string, boolean>>({});
const kbApplyBusy = ref(false);
const kbHasStagedChanges = computed(() =>
  agentKbs.value.some(kb => !!pendingKb.value[kb.key] !== !!kb.connected)
);

// Inline KB-2 indexing progress (its OWN DO job poll — independent of
// the Saved Files indexing panel). Shown in the My Agent tab only.
const kb2Index = ref<{
  active: boolean; tokens: string; filesIndexed: number;
  elapsedSec: number; done: boolean; failed: boolean;
}>({ active: false, tokens: '0', filesIndexed: 0, elapsedSec: 0, done: false, failed: false });
let kb2PollTimer: ReturnType<typeof setInterval> | null = null;
let kb2ElapsedTimer: ReturnType<typeof setInterval> | null = null;
let kb2StartedAt = 0;

const stopKb2Poll = () => {
  if (kb2PollTimer) { clearInterval(kb2PollTimer); kb2PollTimer = null; }
  if (kb2ElapsedTimer) { clearInterval(kb2ElapsedTimer); kb2ElapsedTimer = null; }
};

const startKb2Poll = () => {
  stopKb2Poll();
  kb2StartedAt = Date.now();
  kb2Index.value = { active: true, tokens: '0', filesIndexed: 0, elapsedSec: 0, done: false, failed: false };
  kb2ElapsedTimer = setInterval(() => {
    if (kb2Index.value.active) kb2Index.value.elapsedSec = Math.round((Date.now() - kb2StartedAt) / 1000);
  }, 1000);
  const poll = async () => {
    try {
      const r = await fetch(`/api/kb2-indexing-status?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      if (d && d.exists) {
        kb2Index.value.tokens = String(d.tokens ?? kb2Index.value.tokens);
        kb2Index.value.filesIndexed = Number(d.filesIndexed ?? kb2Index.value.filesIndexed) || 0;
        if (d.completed || d.failed) {
          kb2Index.value.active = false;
          kb2Index.value.done = !!d.completed;
          kb2Index.value.failed = !!d.failed;
          stopKb2Poll();
        }
      }
    } catch { /* keep polling */ }
  };
  poll();
  kb2PollTimer = setInterval(poll, 10000);
};

const loadingChats = ref(false);
const chatsError = ref('');
const sharedChats = ref<SavedChat[]>([]);

// Patient Summary
const loadingSummary = ref(false);
const generatingSummary = ref(false);
const summaryGenerationStep = ref(0);
const summaryElapsed = ref(0);
let summaryTimer: ReturnType<typeof setInterval> | null = null;
const summaryGenerationSteps = [
  { label: 'Parsing patient identity from PDF headers', delay: 2 },
  { label: 'Extracting verified medications', delay: 3 },
  { label: 'Scanning Apple Health for out-of-range labs', delay: 6 },
  { label: 'Extracting allergies', delay: 8 },
  { label: 'Extracting encounters (past 12 months)', delay: 11 },
  { label: 'Extracting medical & social history', delay: 14 },
  { label: 'Extracting radiology / imaging', delay: 17 },
  { label: 'Building stopped medications list', delay: 20 },
  { label: 'Querying AI agent with knowledge base...', delay: 23 },
];
const startSummaryProgress = () => {
  summaryGenerationStep.value = 0;
  summaryElapsed.value = 0;
  if (summaryTimer) clearInterval(summaryTimer);
  summaryTimer = setInterval(() => {
    summaryElapsed.value++;
    const nextStep = summaryGenerationSteps.findIndex(s => s.delay > summaryElapsed.value);
    summaryGenerationStep.value = nextStep < 0 ? summaryGenerationSteps.length : nextStep;
  }, 1000);
};
const stopSummaryProgress = () => {
  if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
  generatingSummary.value = false;
};
const summaryError = ref('');

// Privacy Filter
const loadingPrivacyFilter = ref(false);
const privacyFilterError = ref('');
const privacyFilterResponse = ref('');
const privacyFilterMapping = ref<Array<{ original: string; pseudonym: string }>>([]);
const loadingRandomNames = ref(false);
const patientSummary = ref('');
const patientSummaries = ref<Array<{ text: string; createdAt: string; updatedAt: string; isCurrent: boolean }>>([]);

/**
 * True when the stored Patient Summary contains the sentinel string
 * the server emits when no file in the KB yielded a parseable patient
 * identity (see server/index.js → buildPatientSummaryPromptForUser →
 * `Patient name not parseable from records`). Drives the orange
 * "Patient identity could not be parsed" banner above the summary.
 * Cheap substring check on the rendered text.
 */
const identityParseFailed = computed(() =>
  /patient\s+name\s+not\s+parseable\s+from\s+records/i.test(String(patientSummary.value || ''))
);

// Current Medications ↔ Patient Summary consistency check
const verifiedCurrentMedications = ref<string | null>(null);
const showMedsMismatchDialog = ref(false);
const medsMismatchAcknowledged = ref(false);
const pendingSummaryRegeneration = ref(false);

// Local folder reminder after file deletion
const showLocalFolderDeleteReminder = ref(false);
const deletedFileName = ref('');;

// Patient Diary
const loadingDiary = ref(false);
const diaryError = ref('');
const diaryEntries = ref<Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>>([]);
const diaryInputText = ref('');
const isSavingDiary = ref(false);
const diaryMessagesRef = ref<HTMLElement | null>(null);

// Shared References
const loadingReferences = ref(false);
const referencesError = ref('');
const referenceFiles = ref<Array<{ fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }>>([]);
const referenceFileInput = ref<HTMLInputElement | null>(null);
const isUploadingReference = ref(false);
const selectedReferenceForChat = ref<{ fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string } | null>(null);
const savedCurrentSummaryForUndo = ref<{ text: string; createdAt: string; updatedAt: string } | null>(null);
const showReplaceSummaryDialog = ref(false);
const newSummaryToReplace = ref('');

// PDF Viewer
const showPdfViewer = ref(false);
// Page to jump to when opening the PDF viewer via a File-N citation
// click in the Patient Summary tab. Reset to undefined for direct
// "view file" clicks (which default to page 1).
const pdfViewerInitialPage = ref<number | undefined>(undefined);

// Render arbitrary Patient Summary text (current PS, dual-summary
// candidates, saved-summary viewer, replace-summary modal) through
// processFileNCitations — rewrites raw-filename citations into
// [File N p.<N>] tags, wraps File N mentions into clickable
// anchors, appends a File legend. Rendered via local markdown-it
// with html:true so the anchors survive (vue-markdown-render's
// default strips HTML). Caller must put a @click handler on the
// container that calls handlePsCitationClick to actually open the
// PDF when one of the anchors is clicked.
const renderPsHtml = (text: string | null | undefined): string => {
  const txt = String(text || '');
  if (!txt.trim()) return '';
  const processed = processFileNCitations(txt, userFiles.value as any);
  return psMarkdown.render(processed);
};
const patientSummaryHtml = computed(() => {
  void userFiles.value;
  return renderPsHtml(patientSummary.value);
});
const handlePsCitationClick = (event: Event) => {
  const target = event.target as HTMLElement;
  const link = target.closest('.page-link') as HTMLElement | null;
  if (!link) return;
  event.preventDefault();
  const bucketKey = link.getAttribute('data-bucket-key');
  const fileName = link.getAttribute('data-filename');
  const pageStr = link.getAttribute('data-page');
  if (!bucketKey || !fileName) return;
  const page = pageStr ? parseInt(pageStr, 10) : undefined;
  pdfViewerInitialPage.value = page;
  // Build a minimal UserFile shape so viewFileInPdfViewer works.
  viewFileInPdfViewer({
    fileName,
    bucketKey,
    fileSize: 0,
    uploadedAt: '',
    inKnowledgeBase: true
  } as UserFile);
};
const showTextViewer = ref(false);
const viewingFile = ref<any>(null);

// KB management
const originalFiles = ref<UserFile[]>([]);
const indexedFiles = ref<string[]>([]); // Track which files are actually indexed
const kbNeedsUpdate = ref(false); // Track if KB needs to be updated (files moved)
const kbSummaryTokens = ref<string | number | null>(null);
const kbSummaryFiles = ref<number | null>(null);
const summaryNeedsVerify = ref(false);
const showUpdateSummaryDialog = ref(false);
/** Once the user dismisses the summary tab without verifying this session, don't auto-reopen. */
const summaryDismissedThisSession = ref(false);
const showSummaryAttention = computed(() => summaryNeedsVerify.value);
const kbDataSourceCount = ref<number | null>(null);
const kbIndexedDataSourceCount = ref<number | null>(null);
const kbIndexingActiveOnServer = ref(false);
// Rehydration flow (temporary account restore)
const rehydrationQueue = ref<Array<{ fileName?: string; bucketKey?: string; fileSize?: number; uploadedAt?: string; chipStatus?: string; kbName?: string | null; isInitial?: boolean }>>([]);
const rehydrationCompleted = ref<Set<string>>(new Set());
const rehydrationUploading = ref(false);
const rehydrationInput = ref<HTMLInputElement | null>(null);
const rehydrationStep = ref(0);

const normalizeRehydrationName = (entry: { fileName?: string; bucketKey?: string }) => {
  if (entry.fileName) return entry.fileName;
  const key = entry.bucketKey || '';
  return key.split('/').pop() || key;
};

const rehydrationRemaining = computed(() =>
  rehydrationQueue.value.filter(entry => !rehydrationCompleted.value.has(normalizeRehydrationName(entry)))
);

const rehydrationDisplayList = computed(() => rehydrationQueue.value.map(entry => {
  const name = normalizeRehydrationName(entry);
  return {
    ...entry,
    displayName: entry.fileName || entry.bucketKey || 'Unknown file',
    restored: rehydrationCompleted.value.has(name)
  };
}));

const rehydrationCurrent = computed(() => rehydrationRemaining.value[0] || null);

watch(
  () => props.rehydrationFiles,
  (files) => {
    if (Array.isArray(files) && files.length > 0) {
      rehydrationQueue.value = files;
      rehydrationCompleted.value = new Set();
      rehydrationStep.value = 0;
    } else {
      rehydrationQueue.value = [];
      rehydrationCompleted.value = new Set();
      rehydrationStep.value = 0;
    }
  },
  { immediate: true }
);

const triggerRehydrationInput = () => {
  rehydrationInput.value?.click();
};

const handleRehydrationFileSelected = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = '';
  if (!file || !props.userId) return;

  const currentEntry = rehydrationCurrent.value || null;
  const expected = currentEntry ? normalizeRehydrationName(currentEntry) : null;
  if (!expected) return;

  if (file.name !== expected) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: `Please select the file named "${expected}".`,
        timeout: 4000
      });
    }
    return;
  }

  rehydrationUploading.value = true;
  try {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch('/api/files/upload', {
      method: 'POST',
      credentials: 'include',
      body: formData
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to upload file');
    }
    const uploadResult = await response.json();
    if (uploadResult?.fileInfo) {
      try {
        const isAppleHealth = String(uploadResult.fileInfo.fileName || '').toLowerCase().endsWith('.pdf')
          ? await detectAppleHealthFromBucket(uploadResult.fileInfo.bucketKey)
          : false;
        await fetch('/api/user-file-metadata', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.userId,
            fileMetadata: {
              fileName: uploadResult.fileInfo.fileName,
              bucketKey: uploadResult.fileInfo.bucketKey,
              bucketPath: uploadResult.fileInfo.userFolder,
              fileSize: uploadResult.fileInfo.size,
              fileType: uploadResult.fileInfo.mimeType,
              uploadedAt: uploadResult.fileInfo.uploadedAt,
              isAppleHealth: isAppleHealth
            },
            updateInitialFile: !!currentEntry?.isInitial
          })
        });
      } catch (metadataError) {
        console.warn('Rehydration metadata update failed:', metadataError);
      }
    }
    rehydrationCompleted.value.add(expected);
    rehydrationStep.value += 1;
    await loadFiles();
    emit('rehydration-file-removed', {
      fileName: expected,
      bucketKey: currentEntry?.bucketKey
    });
  } catch (error) {
    console.error('Rehydration upload failed:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to upload file',
        timeout: 4000
      });
    }
  } finally {
    rehydrationUploading.value = false;
  }

  if (rehydrationRemaining.value.length === 0) {
    const hasInitialFile = rehydrationQueue.value.some(entry => !!entry.isInitial);
    emit('rehydration-complete', { hasInitialFile });
  }
};

const hasCheckboxChanges = computed(() => {
  if (originalFiles.value.length !== userFiles.value.length) return true;
  return userFiles.value.some((file, index) => {
    const original = originalFiles.value[index];
    return !original || file.inKnowledgeBase !== original.inKnowledgeBase || !!file.pendingKbAdd;
  });
});

const hasPendingKbAdds = computed(() => userFiles.value.some(file => !!file.pendingKbAdd));

// Mark KB as dirty when files are moved
watch(hasCheckboxChanges, (hasChanges) => {
  if (hasChanges && !indexingKB.value) {
    kbNeedsUpdate.value = true;
  }
});
// Check if KB folder contents match indexed files
const kbIndexingOutOfSync = computed(() => {
  // Get all files currently in KB folder (inKnowledgeBase = true)
  const currentKBFiles = userFiles.value
    .filter(file => file.inKnowledgeBase)
    .map(file => file.bucketKey);
  
  // Sort both arrays for comparison
  const currentSorted = [...currentKBFiles].sort();
  const indexedSorted = [...indexedFiles.value].sort();
  
  // Compare arrays
  if (currentSorted.length !== indexedSorted.length) return true;
  return currentSorted.some((key, index) => key !== indexedSorted[index]);
});

// Computed property that returns a function to check if a file is indexed (ensures reactivity)
const isFileIndexed = computed(() => {
  // Create a Set for O(1) lookup
  const indexedSet = new Set(indexedFiles.value);
  // Return a function that checks if a bucketKey is in the set
  return (bucketKey: string): boolean => {
    return indexedSet.has(bucketKey);
  };
});

const indexingKB = ref(false);
const cancellingIndexing = ref(false);
const indexingStatus = ref({
  phase: 'moving', // 'moving' | 'kb_setup' | 'indexing_started' | 'indexing' | 'complete' | 'error'
  message: '',
  kb: '',
  tokens: '',
  filesIndexed: 0,
  progress: 0,
  error: ''
});

const currentIndexingJobId = ref<string | null>(null);
const pollingInterval = ref<ReturnType<typeof setInterval> | null>(null);
const elapsedTimeInterval = ref<ReturnType<typeof setInterval> | null>(null);
const indexingStartTime = ref<number | null>(null);
const INDEXING_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const elapsedTimeUpdate = ref(0); // Force updates for elapsed time display

// Computed property for elapsed time display
const indexingElapsedTime = computed(() => {
  if (!indexingStartTime.value) return null;
  // Use elapsedTimeUpdate to force reactivity
  void elapsedTimeUpdate.value; // Force reactivity by reading the value
  const elapsed = Date.now() - indexingStartTime.value;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
});

// Patient summary modal state
const showSummaryAvailableModal = ref(false);
const showSummaryViewModal = ref(false);
const isSummaryModalBeforeGeneration = ref(false); // true = before generation, false = after generation
const pendingSummaryGeneration = ref<(() => Promise<void>) | null>(null);
const newPatientSummary = ref('');
const editingSummary = ref(false);
const summaryViewText = ref('');
const isEditingSummaryTab = ref(false);
const summaryEditText = ref('');
const isSavingSummary = ref(false);

watch(patientSummary, (newValue) => {
  if (!isEditingSummaryTab.value) {
    summaryEditText.value = newValue || '';
  }
});

const hasUnsavedAgentChanges = computed(() => {
  if (!editMode.value) return false;
  const current = (editedInstructions.value || '').trim();
  const original = (agentInstructions.value || '').trim();
  return current !== original;
});

const hasUnsavedSummaryChanges = computed(() => {
  if (!isEditingSummaryTab.value) return false;
  const current = (summaryEditText.value || '').trim();
  const original = (patientSummary.value || '').trim();
  return current !== original;
});

const hasUnsavedChanges = computed(() => hasUnsavedAgentChanges.value || hasUnsavedSummaryChanges.value);

const $q = useQuasar();

const loadFiles = async () => {
  loadingFiles.value = true;
  filesError.value = '';

  try {
    // Auto-archive any files at root level (userId/) to archived folder.
    // Paperclip uploads land at root and are temporary (removed on reload).
    // Archiving preserves them so they appear in Saved Files with proper badges.
    try {
      const archiveResponse = await fetch('/api/archive-user-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: props.userId })
      });

      if (archiveResponse.ok) {
        const archiveResult = await archiveResponse.json();
        if (archiveResult.archivedFiles?.length > 0) {
          const originalRootKeys = archiveResult.archivedFiles.map(
            (fileName: string) => `${props.userId}/${fileName}`
          );
          emit('files-archived', originalRootKeys);
        }
      }
    } catch (archiveErr) {
      console.warn('Failed to auto-archive files:', archiveErr);
    }

    // Then load files as normal
    const response = await fetch(`/api/user-files?userId=${encodeURIComponent(props.userId)}&source=saved`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch files: ${response.statusText}`);
    }
    const result = await response.json();
    
    const kbName = result.kbName as string | undefined;
    const kbFolderPrefix = kbName ? `${props.userId}/${kbName}/` : null;
    userFiles.value = (result.files || []).map((file: any) => {
      const bucketKey = file.bucketKey || '';
      const isInKB = typeof file.inKnowledgeBase === 'boolean'
        ? file.inKnowledgeBase
        : (kbFolderPrefix ? bucketKey.startsWith(kbFolderPrefix) : false);
      return {
        ...file,
        inKnowledgeBase: isInKB,
        pendingKbAdd: false
      };
    });
    originalFiles.value = JSON.parse(JSON.stringify(userFiles.value));

    let pendingFileName: string | null = null;
    try {
      pendingFileName = localStorage.getItem(getWizardPendingKey());
    } catch (error) {
      pendingFileName = null;
    }

    if (pendingFileName) {
      const pendingFile = userFiles.value.find(file => file.fileName === pendingFileName);
      if (pendingFile) {
        pendingFile.pendingKbAdd = true;
        if (!pendingFile.inKnowledgeBase) {
          pendingFile.inKnowledgeBase = true;
          await onCheckboxChange(pendingFile, { silent: true });
        }
      } else {
        clearWizardPendingStorage();
      }
    }
    
    const indexingActive = !!result.kbIndexingActive;
    kbIndexingActiveOnServer.value = indexingActive;
    kbDataSourceCount.value = typeof result.kbDataSourceCount === 'number' ? result.kbDataSourceCount : null;
    kbIndexedDataSourceCount.value = typeof result.kbIndexedDataSourceCount === 'number' ? result.kbIndexedDataSourceCount : null;

    indexedFiles.value = Array.isArray(result.kbIndexedBucketKeys)
      ? result.kbIndexedBucketKeys
      : [];
    kbSummaryFiles.value = indexedFiles.value.length;
    kbSummaryTokens.value = result.kbTotalTokens !== undefined && result.kbTotalTokens !== null
      ? result.kbTotalTokens
      : null;

    kbNeedsUpdate.value = false;
    if (!indexingActive && pendingFileName) {
      const pendingFile = userFiles.value.find(file => file.fileName === pendingFileName);
      if (pendingFile && isFileIndexed.value(pendingFile.bucketKey)) {
        pendingFile.pendingKbAdd = false;
        clearWizardPendingStorage();
      }
    }

  } catch (err) {
    filesError.value = err instanceof Error ? err.message : 'Failed to load files';
  } finally {
    loadingFiles.value = false;
  }
  // Run the patient-consistency check whenever the file set is
  // refreshed. Result drives the SAFETY banner at the top of this
  // tab. Best-effort and silent on failure — banner just stays
  // hidden if the check can't complete.
  void checkPatientConsistency();
};

// const _toggleKnowledgeBase = async (file: UserFile) => {
//   updatingFiles.value.add(file.bucketKey);
//
//   try {
//     const response = await fetch('/api/toggle-file-knowledge-base', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json'
//       },
//       credentials: 'include',
//       body: JSON.stringify({
//         userId: props.userId,
//         bucketKey: file.bucketKey,
//         inKnowledgeBase: file.inKnowledgeBase
//       })
//     });
//
//     if (!response.ok) {
//       throw new Error('Failed to update knowledge base status');
//     }
//
//     // Reload files to get updated state
//     await loadFiles();
//   } catch (err) {
//     filesError.value = err instanceof Error ? err.message : 'Failed to update knowledge base status';
//     // Revert checkbox on error
//     file.inKnowledgeBase = !file.inKnowledgeBase;
//   } finally {
//     updatingFiles.value.delete(file.bucketKey);
//   }
// };

const loadAgent = async () => {
  loadingAgent.value = true;
  agentError.value = '';

  try {
    // Discover which Private AI profiles exist (one sub-tab each).
    try {
      const provResp = await fetch('/api/chat/providers', { credentials: 'include' });
      if (provResp.ok) {
        const pd = await provResp.json();
        const list = Array.isArray(pd.privateAiProfiles) ? pd.privateAiProfiles : [];
        agentProfilesList.value = list.map((p: { key: string; label: string }) => ({ key: p.key, label: p.label }));
        // Don't reset activeAgentProfile when the current tab isn't in
        // the deployed-profiles list — the 'gpt' tab is always rendered
        // and handles the undeployed state with a Deploy button.
      }
    } catch { /* non-fatal — fall back to default profile only */ }

    const response = await fetch(
      `/api/agent-instructions?userId=${encodeURIComponent(props.userId)}&agentProfileKey=${encodeURIComponent(activeAgentProfile.value)}`,
      { credentials: 'include' }
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch agent: ${response.statusText}`);
    }
    const result = await response.json();
    agentInstructions.value = result.instructions || '';
    editedInstructions.value = result.instructions || '';
    kbInfo.value = result.kbInfo || null;
    agentKbs.value = Array.isArray(result.kbs) ? result.kbs : [];
    // Seed the staged checkboxes from the actual connection state.
    const seeded: Record<string, boolean> = {};
    for (const kb of agentKbs.value) seeded[kb.key] = !!kb.connected;
    pendingKb.value = seeded;

    // Load deep link Private AI access setting
    await loadDeepLinkPrivateAISetting();
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : 'Failed to load agent';
  } finally {
    loadingAgent.value = false;
  }
};

// Reload instructions + KB status when the user switches Private AI
// sub-tab. Exits edit mode so unsaved edits don't bleed across agents.
watch(activeAgentProfile, () => {
  editMode.value = false;
  stopKb2Poll();
  kb2Index.value = { active: false, tokens: '0', filesIndexed: 0, elapsedSec: 0, done: false, failed: false };
  loadAgent();
});

const loadDeepLinkPrivateAISetting = async () => {
  try {
    const response = await fetch(`/api/user-settings?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (response.ok) {
      const result = await response.json();

      if (result.followupJobId && result.followupJobId !== currentIndexingJobId.value) {
        currentIndexingJobId.value = result.followupJobId;
        if (pollingInterval.value) {
          clearInterval(pollingInterval.value);
          pollingInterval.value = null;
        }
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        indexingStatus.value.message = result.message || 'Indexing remaining files...';
        await pollIndexingProgress(result.followupJobId);
        return;
      }
      // Default to true if not set (backward compatibility)
      allowDeepLinkPrivateAI.value = result.allowDeepLinkPrivateAI !== undefined ? result.allowDeepLinkPrivateAI : true;
    }
  } catch (err) {
    // If endpoint doesn't exist yet or fails, default to true
    console.warn('Failed to load deep link setting, defaulting to enabled:', err);
    allowDeepLinkPrivateAI.value = true;
  }
};

const saveDeepLinkPrivateAISetting = async () => {
  savingDeepLinkSetting.value = true;
  try {
    const response = await fetch('/api/user-settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        allowDeepLinkPrivateAI: allowDeepLinkPrivateAI.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save setting');
    }

    // Show notification
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: allowDeepLinkPrivateAI.value 
          ? 'Deep link users can now access your Private AI' 
          : 'Deep link users can no longer access your Private AI',
        timeout: 3000
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to save setting';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: errorMsg,
        timeout: 3000
      });
    }
    // Revert on error
    allowDeepLinkPrivateAI.value = !allowDeepLinkPrivateAI.value;
  } finally {
    savingDeepLinkSetting.value = false;
  }
};

const saveInstructions = async () => {
  savingInstructions.value = true;

  try {
    const response = await fetch('/api/agent-instructions', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        instructions: editedInstructions.value,
        agentProfileKey: activeAgentProfile.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save instructions');
    }

    agentInstructions.value = editedInstructions.value;
    editMode.value = false;
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : 'Failed to save instructions';
  } finally {
    savingInstructions.value = false;
  }
};

const cancelEdit = () => {
  editedInstructions.value = agentInstructions.value;
  editMode.value = false;
};


// Toggle KB connection
// Connect/disconnect a specific KB (kb1 = primary/semantic,
// kb2 = alternate/hierarchical) for the CURRENT agent sub-tab.
// kb2's first connect lazily creates + indexes it server-side.
// Apply all STAGED KB connect/disconnect changes for the current agent
// sub-tab, then (if KB-2 was just created) switch to the Saved Files
// tab and surface its indexing in the existing progress panel. This
// never calls /api/update-knowledge-base, so the per-file Saved Files
// badges are NOT recomputed by a KB-connection change.
const applyKbChanges = async () => {
  if (kbApplyBusy.value) return;
  const changes = agentKbs.value
    .filter(kb => !!pendingKb.value[kb.key] !== !!kb.connected)
    .map(kb => ({ key: kb.key, label: kb.label, attach: !!pendingKb.value[kb.key] }));
  if (changes.length === 0) return;

  kbApplyBusy.value = true;
  let kb2IndexJobId: string | null = null;
  try {
    for (const ch of changes) {
      const response = await fetch('/api/toggle-kb-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.userId,
          action: ch.attach ? 'attach' : 'detach',
          kbKey: ch.key,
          agentProfileKey: activeAgentProfile.value
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success === false) {
        throw new Error(result.message || result.error || `Failed to update ${ch.label}`);
      }
      const idx = agentKbs.value.findIndex(k => k.key === ch.key);
      if (idx >= 0) agentKbs.value[idx].connected = !!result.connected;
      if (ch.key === 'kb2' && result.indexJobId) kb2IndexJobId = result.indexJobId;
    }

    if ($q?.notify) {
      $q.notify({ type: 'positive', message: 'Knowledge base changes applied', timeout: 3000 });
    }

    // A KB-connection change never moves files, so the Saved Files
    // indexed state is unchanged — but it must be refreshed from the
    // server (and its dirty baseline reset) so the tab doesn't keep a
    // STALE "no file in KB / you changed files" view after the switch.
    await loadFiles();
    await loadAgent(); // refresh per-agent KB connection badges

    // If KB-2 was just created it is indexing — show progress INLINE in
    // this My Agent tab (its own DO job poll). We deliberately do NOT
    // switch to Saved Files or touch the Saved Files indexing panel.
    if (kb2IndexJobId) startKb2Poll();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to apply KB changes';
    if ($q?.notify) $q.notify({ type: 'negative', message: msg, timeout: 5000 });
  } finally {
    kbApplyBusy.value = false;
  }
};

// Get file names from indexed files (extract from bucketKey) - computed property for performance
const indexedFileNames = computed((): string[] => {
  return indexedFiles.value.map(bucketKey => {
    // Extract filename from bucketKey (format: userId/kbName/filename or userId/archived/filename)
    const parts = bucketKey.split('/');
    return parts[parts.length - 1] || bucketKey;
  });
});

const loadSharedChats = async () => {
  loadingChats.value = true;
  chatsError.value = '';

  try {
    const response = await fetch(`/api/shared-group-chats?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch chats: ${response.statusText}`);
    }
    const result = await response.json();
    sharedChats.value = result.chats || [];
  } catch (err) {
    chatsError.value = err instanceof Error ? err.message : 'Failed to load chats';
  } finally {
    loadingChats.value = false;
  }
};

const getLastQueryDescription = (chat: SavedChat): string => {
  if (!chat.chatHistory || chat.chatHistory.length === 0) {
    return 'No messages';
  }

  // Find the last user message
  for (let i = chat.chatHistory.length - 1; i >= 0; i--) {
    if (chat.chatHistory[i].role === 'user' && chat.chatHistory[i].content) {
      const content = chat.chatHistory[i].content;
      // Return first 100 characters
      return content.length > 100 ? content.substring(0, 100) + '...' : content;
    }
  }

  return 'No user query found';
};

const getGroupParticipants = (chat: SavedChat): string => {
  if (!chat.isShared || !chat.currentUser) {
    return 'None';
  }

  // For now, just return the current user
  // TODO: Extract all participants from chat history
  return chat.currentUser;
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    return pageText.includes('this summary displays certain health information made available to you by your healthcare provider and may not completely');
  } catch (error) {
    return false;
  }
};

const formatFileSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const formatNumber = (value: string | number) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(parsed)) return String(value);
  return parsed.toLocaleString();
};

const getWizardPendingKey = () =>
  props.userId ? `wizardKbPendingFileName-${props.userId}` : 'wizardKbPendingFileName';

const wizardStage3IndexingStartedKey = () =>
  props.userId ? `wizard_stage3_indexing_started_${props.userId}` : null;

const clearWizardPendingStorage = () => {
  try {
    localStorage.removeItem(getWizardPendingKey());
  } catch (error) {
    // ignore
  }
};

const clearWizardPendingKbSelection = () => {
  clearWizardPendingStorage();
  userFiles.value.forEach(file => {
    if (file.pendingKbAdd) {
      file.pendingKbAdd = false;
    }
  });
  if (!indexingKB.value) {
    kbNeedsUpdate.value = hasCheckboxChanges.value;
  }
};

const handleKbSelectionChange = async (file: UserFile, value: boolean) => {
  if (!value && file.pendingKbAdd) {
    clearWizardPendingKbSelection();
  }
  file.inKnowledgeBase = value;
  await onCheckboxChange(file);
};

const toggleKbCheckbox = async (file: UserFile) => {
  await handleKbSelectionChange(file, !file.inKnowledgeBase);
};

// File management methods
const onCheckboxChange = async (file: UserFile, options: { silent?: boolean; retry?: boolean } = {}) => {
  // Immediately move file when checkbox is toggled
  const oldBucketKey = file.bucketKey;
  const newStatus = file.inKnowledgeBase;
  
  // Add to updating set to show spinner
  updatingFiles.value.add(oldBucketKey);

  try {
    const response = await fetch('/api/toggle-file-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        bucketKey: oldBucketKey,
        inKnowledgeBase: newStatus
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.message || 'Failed to update knowledge base status';
      if (response.status === 404 && errorData.error === 'FILE_NOT_FOUND' && options.retry !== false) {
        await loadFiles();
        const refreshed = userFiles.value.find(f => f.fileName === file.fileName);
        if (refreshed) {
          refreshed.inKnowledgeBase = newStatus;
          await onCheckboxChange(refreshed, { silent: options.silent, retry: false });
          return;
        }
      }
      throw new Error(errorMsg);
    }

    const result = await response.json();
    
    // Reload files list to verify the move completed and matches the display
    await loadFiles();
    
    // Verify the file was moved correctly by checking the new file list
    const updatedFile = userFiles.value.find(f => 
      f.bucketKey === result.newBucketKey || 
      (result.newBucketKey && f.bucketKey === oldBucketKey && f.fileName === file.fileName)
    );
    
    if (updatedFile) {
      // Show success notification
      if (!options.silent && $q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: `File ${newStatus ? 'added to' : 'removed from'} knowledge base`,
          timeout: 2000
        });
      }
    }

    if (newStatus) {
      const keysToClear = [oldBucketKey, result.newBucketKey].filter(Boolean);
      emit('files-archived', keysToClear);
      // Notify parent to copy file to local MAIA folder
      emit('file-added-to-kb', {
        fileName: file.fileName,
        bucketKey: result.newBucketKey || oldBucketKey
      });
    }
    
    // Mark KB as dirty since a file was moved in/out of KB
    // loadFiles() now syncs from server, so no local override needed here
    
  } catch (err) {
    console.error(`Error toggling file ${file.fileName}:`, err);
    // Revert checkbox on error
    file.inKnowledgeBase = !newStatus;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to update knowledge base status',
        timeout: 5000
      });
    }
  } finally {
    // Remove from updating set - use both old and new bucketKey in case it changed
    updatingFiles.value.delete(oldBucketKey);
    // Also try to remove any potential new bucketKey if the operation partially completed
    if (file.bucketKey && file.bucketKey !== oldBucketKey) {
      updatingFiles.value.delete(file.bucketKey);
    }
  }
};

// Helper to detect file type from stored file metadata
const detectFileTypeFromMetadata = (fileName: string, fileType?: string): 'text' | 'pdf' | 'markdown' => {
  // If fileType is already set and valid, use it
  if (fileType === 'pdf' || fileType === 'text' || fileType === 'markdown') {
    return fileType;
  }
  
  // Otherwise, detect from filename
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }
  if (ext === 'txt' || ext === 'text') {
    return 'text';
  }
  
  // Default to text for unknown types (safer than assuming PDF)
  return 'text';
};

const viewFileInPdfViewer = (file: UserFile) => {
  viewingFile.value = {
    bucketKey: file.bucketKey,
    name: file.fileName,
    type: detectFileTypeFromMetadata(file.fileName, file.fileType)
  };

  // Determine file type and open appropriate viewer
  const fileType = detectFileTypeFromMetadata(file.fileName, file.fileType);
  if (fileType === 'pdf') {
    showPdfViewer.value = true;
    showTextViewer.value = false;
  } else {
    // Non-PDFs ignore initialPage; clear it so the next PDF open doesn't inherit a stale value.
    pdfViewerInitialPage.value = undefined;
    // Default to text viewer for text, markdown, and unknown types
    showTextViewer.value = true;
    showPdfViewer.value = false;
  }
};

const confirmDeleteFile = (file: UserFile) => {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Delete File',
      message: 'This will delete the file from MAIA, remove it from the knowledge base, and re-index. Make sure you have copies of your valuable files on your computer.',
      cancel: true,
      persistent: true
    }).onOk(() => {
      deleteFile(file);
    });
  } else if (window.confirm('This will delete the file from MAIA, remove it from the knowledge base, and re-index. Make sure you have copies of your valuable files on your computer. Are you sure you want to delete this file?')) {
    deleteFile(file);
  }
};

const deleteFile = async (file: UserFile) => {
  // Add file to updating set to show loading state
  updatingFiles.value.add(file.bucketKey);
  
  try {
    const response = await fetch(`/api/delete-file`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        bucketKey: file.bucketKey
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || 'Failed to delete file');
    }

    // Reload files to refresh the list
    await loadFiles();
    
    // If file was in KB, mark KB as needing update
    if (file.inKnowledgeBase) {
      kbNeedsUpdate.value = true;
    }
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'File deleted successfully',
        timeout: 3000
      });
    }

    // Remind user to also delete from local folder
    deletedFileName.value = file.fileName || file.bucketKey?.split('/').pop() || 'the file';
    showLocalFolderDeleteReminder.value = true;

    if (props.rehydrationActive) {
      const removedName = normalizeRehydrationName(file);
      rehydrationQueue.value = rehydrationQueue.value.filter(entry => normalizeRehydrationName(entry) !== removedName);
      rehydrationCompleted.value.delete(removedName);
      emit('rehydration-file-removed', { bucketKey: file.bucketKey, fileName: file.fileName });
      if (rehydrationQueue.value.length === 0) {
        emit('rehydration-complete', { hasInitialFile: false });
      }
    }
  } catch (err) {
    console.error('Error deleting file:', err);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to delete file',
        timeout: 5000
      });
    }
  } finally {
    updatingFiles.value.delete(file.bucketKey);
  }
};

const updateAndIndexKB = async () => {
  clearWizardPendingKbSelection();
  indexingKB.value = true;
  indexingStatus.value = {
    phase: 'moving',
    message: 'Moving files to knowledge base folder...',
    kb: '',
    tokens: '',
    filesIndexed: 0,
    progress: 0,
    error: ''
  };

  try {
    // Files are already moved by checkboxes - no need to send changes array
    // Phase 1: KB Setup (no longer moving files)
    indexingStatus.value.phase = 'kb_setup';
    indexingStatus.value.message = 'Setting up knowledge base...';

    const response = await fetch('/api/update-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = { message: `HTTP ${response.status}: ${response.statusText}` };
      }
      throw new Error(errorData.message || `Failed to update knowledge base: ${response.status}`);
    }

    const result = await response.json();
    
    // Update original files
    originalFiles.value = JSON.parse(JSON.stringify(userFiles.value));
    
    // Clear dirty flag since we're now indexing
    kbNeedsUpdate.value = false;
    
    // If jobId is returned, start polling
    if (result.jobId) {
      currentIndexingJobId.value = result.jobId;
      // Update phase based on response
      indexingStatus.value.phase = result.phase || 'indexing_started';
      indexingStatus.value.message = result.phase === 'indexing_started' 
        ? 'Indexing job started... This may take several minutes'
        : 'Setting up knowledge base...';
      indexingStatus.value.kb = result.kbId || result.kb || '';
      
      // Start polling for status
      pollIndexingProgress(result.jobId);
    } else if (result.error === 'INDEXING_ALREADY_RUNNING') {
      // KB already has an indexing job running - check if we can get the job ID
      if (result.kbId) {
        // Try to get the existing job ID from user document
        // For now, show a message and suggest waiting
        indexingKB.value = false;
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = result.message || 'Indexing job already running';
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'warning',
            message: 'Indexing already in progress. Please wait for it to complete.',
            timeout: 5000
          });
        } else {
          alert('Indexing already in progress. Please wait for it to complete.');
        }
      } else {
        throw new Error(result.message || 'Indexing job already running');
      }
    } else if (result.kbId && result.success) {
      // KB was created but jobId is null - indexing should start automatically
      // Poll for the job ID to appear
      indexingKB.value = true;
      indexingStatus.value.phase = 'indexing_started';
      indexingStatus.value.message = 'Knowledge base created. Waiting for indexing to start...';
      indexingStatus.value.kb = result.kbId;
      
      // Poll for job ID (up to 10 attempts with 3 second delays = 30 seconds max)
      let foundJobId = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        try {
          const statusResponse = await fetch(`/api/user-files?userId=${props.userId}`, {
            method: 'GET',
            credentials: 'include'
          });
          
          if (statusResponse.ok) {
            const statusData = await statusResponse.json();
            const jobId = statusData.kbIndexingJobId || statusData.kbLatestJobId || null;
            if (jobId) {
              foundJobId = jobId;
              break;
            }
          }
        } catch (pollError) {}
      }
      
      if (foundJobId) {
        // Found job ID - start polling for progress
        currentIndexingJobId.value = foundJobId;
        pollIndexingProgress(foundJobId);
      } else {
        // Still no job ID after polling - show message but don't error
        indexingKB.value = false;
        indexingStatus.value.phase = 'complete';
        indexingStatus.value.message = 'Knowledge base created. Indexing will start automatically - please check back in a moment.';
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'info',
            message: 'Knowledge base created. Indexing will start automatically - please check back in a moment.',
            timeout: 5000
          });
        }
        // Reload files to show updated state
        await loadFiles();
        await loadAgent();
      }
    } else {
      // No job ID and no KB ID - something went wrong
      indexingKB.value = false;
      throw new Error('No indexing job ID returned from server');
    }
  } catch (err) {
    indexingKB.value = false;
    indexingStatus.value.phase = 'error';
    indexingStatus.value.error = err instanceof Error ? err.message : 'Failed to update knowledge base';
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'negative',
        message: indexingStatus.value.error,
        timeout: 5000
    });
    } else {
      // Fallback if Quasar notify is not available
      console.error('Notification error:', indexingStatus.value.error);
      alert(`Error: ${indexingStatus.value.error}`);
    }
  }
};

const cancelIndexingAndRestore = async () => {
  if (!currentIndexingJobId.value) {
    return;
  }

  const jobId = currentIndexingJobId.value;
  cancellingIndexing.value = true;

  try {
    // Stop polling
    if (pollingInterval.value) {
      clearInterval(pollingInterval.value);
      pollingInterval.value = null;
    }

    // Call cancel endpoint
    const response = await fetch('/api/cancel-kb-indexing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        jobId: jobId
      })
    });

    const result = await response.json();

    // Check if indexing already completed
    if (result.alreadyCompleted || result.error === 'ALREADY_COMPLETED') {
      // Indexing already completed - just clear frontend state
      
      // Reset indexing state
      indexingKB.value = false;
      currentIndexingJobId.value = null;
      if (elapsedTimeInterval.value) {
        clearInterval(elapsedTimeInterval.value);
        elapsedTimeInterval.value = null;
      }
      indexingStartTime.value = null;
      elapsedTimeUpdate.value = 0;
      indexingStatus.value = {
        phase: 'complete',
        message: 'Indexing already completed',
        kb: '',
        tokens: '',
        filesIndexed: 0,
        progress: 1.0,
        error: ''
      };
      
      // Reload files to get current state
      await loadFiles();

      cancellingIndexing.value = false;

      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'info',
          message: 'Indexing has already completed',
          timeout: 3000
        });
      }
      return;
    }

    if (!response.ok) {
      throw new Error(result.message || 'Failed to cancel indexing');
    }

    // Reset indexing state
    indexingKB.value = false;
    currentIndexingJobId.value = null;
    if (elapsedTimeInterval.value) {
      clearInterval(elapsedTimeInterval.value);
      elapsedTimeInterval.value = null;
    }
    indexingStartTime.value = null;
    elapsedTimeUpdate.value = 0;
    indexingStatus.value = {
      phase: 'moving',
      message: '',
      kb: '',
      tokens: '',
      filesIndexed: 0,
      progress: 0,
      error: ''
    };

    // Reload files to get restored state (this updates bucketKeys)
    await loadFiles();

    // Force a small delay to ensure file list is fully updated before any PDF access
    await new Promise(resolve => setTimeout(resolve, 100));

    // Emit event to refresh any open PDF viewers with updated bucketKeys
    emit('files-archived', []); // Empty array signals a refresh without specific files

    cancellingIndexing.value = false;

    // Show notification
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Indexing cancelled and files restored to archived folder',
        timeout: 3000
      });
    }
  } catch (err) {
    cancellingIndexing.value = false;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to cancel indexing',
        timeout: 5000
      });
    }
  }
};

const pollIndexingProgress = async (jobId: string) => {
  // Clear any existing polling interval
  if (pollingInterval.value) {
    clearInterval(pollingInterval.value);
  }
  
  // Use persisted start time if indexing was started from wizard (survives reload / opening Saved Files mid-indexing)
  const storageKey = wizardStage3IndexingStartedKey();
  try {
    const stored = storageKey ? sessionStorage.getItem(storageKey) : null;
    if (stored) {
      const startedAt = parseInt(stored, 10);
      const maxAgeMs = 24 * 60 * 60 * 1000;
      if (!Number.isNaN(startedAt) && Date.now() - startedAt < maxAgeMs) {
        indexingStartTime.value = startedAt;
      } else {
        if (storageKey) sessionStorage.removeItem(storageKey);
        indexingStartTime.value = Date.now();
      }
    } else {
      indexingStartTime.value = Date.now();
    }
  } catch {
    indexingStartTime.value = Date.now();
  }
  elapsedTimeUpdate.value = 0;
  
  // Start interval to update elapsed time display every second
  if (elapsedTimeInterval.value) {
    clearInterval(elapsedTimeInterval.value);
  }
  elapsedTimeInterval.value = setInterval(() => {
    if (indexingStartTime.value) {
      elapsedTimeUpdate.value = Date.now();
    } else {
      if (elapsedTimeInterval.value) {
        clearInterval(elapsedTimeInterval.value);
        elapsedTimeInterval.value = null;
      }
    }
  }, 1000);
  
  // Emit event to parent to update status tip
  emit('indexing-started', { jobId, phase: 'indexing_started' });
  
  // Poll every 10 seconds for indexing status
  const POLL_INTERVAL_MS = 10000; // 10 seconds
  pollingInterval.value = setInterval(async () => {
    if (!isOpen.value) {
      if (pollingInterval.value) clearInterval(pollingInterval.value);
      pollingInterval.value = null;
      if (elapsedTimeInterval.value) clearInterval(elapsedTimeInterval.value);
      elapsedTimeInterval.value = null;
      return;
    }
    try {
      // Check for timeout
      const elapsed = indexingStartTime.value ? (Date.now() - indexingStartTime.value) : 0;
      if (indexingStartTime.value && elapsed > INDEXING_TIMEOUT_MS) {
        clearInterval(pollingInterval.value!);
        pollingInterval.value = null;
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        indexingStartTime.value = null;
        elapsedTimeUpdate.value = 0;
        indexingKB.value = false;
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = 'Indexing timed out after 60 minutes';
        emit('indexing-finished', { jobId, phase: 'error', error: 'Indexing timed out' });
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'negative',
            message: 'Indexing timed out after 60 minutes. Please check the knowledge base status.'
          });
        }
        return;
      }
      
      const response = await fetch(`/api/user-files?userId=${encodeURIComponent(props.userId)}&source=saved`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error(`Failed to get indexing status: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      if (!isOpen.value) return;
      const statusResult = result.kbIndexingStatus || {};
      if (statusResult.jobId && statusResult.jobId !== jobId) {
        return;
      }
      
      // Status check for job (verbose logging removed)
      
      // Update status with all fields from response
      indexingStatus.value = {
        phase: statusResult.phase || indexingStatus.value.phase,
        message: indexingStatus.value.message,
        kb: result.kbName || indexingStatus.value.kb,
        tokens: statusResult.tokens || indexingStatus.value.tokens || '0',
        filesIndexed: statusResult.filesIndexed || 0,
        progress: statusResult.progress || 0,
        error: statusResult.error || ''
      };
      
      // Emit status update to parent for status tip
      emit('indexing-status-update', {
        jobId,
        phase: indexingStatus.value.phase,
        tokens: indexingStatus.value.tokens,
        filesIndexed: indexingStatus.value.filesIndexed,
        progress: indexingStatus.value.progress
      });

      // Handle completion - check result.backendCompleted (backend has finished all automation),
      // result.completed, result.phase, or result.status
      // backendCompleted is the most reliable indicator that everything is done
      // Log completion detection for debugging
      const isCompleted = statusResult.backendCompleted === true;
      
      if (isCompleted) {
        if (pollingInterval.value !== null) {
          clearInterval(pollingInterval.value);
        }
        pollingInterval.value = null;
        // Note: Keep indexingStartTime and elapsedTimeUpdate for final display
        
        // Refresh dialog for any completion status (not just backendCompleted or phase='complete')
        // This ensures the UI updates when status='INDEX_JOB_STATUS_COMPLETED' even if phase is still 'indexing'
        indexingStatus.value.phase = 'complete';
        indexingStatus.value.message = 'Knowledge base indexed successfully!';
        kbIndexingActiveOnServer.value = false;
        
        if (statusResult.tokens !== undefined) {
          kbSummaryTokens.value = statusResult.tokens;
        }
        if (statusResult.filesIndexed !== undefined) {
          kbSummaryFiles.value = statusResult.filesIndexed;
        }
        
        // Reload files to refresh the file list
        await loadFiles();
        
        emit('indexing-finished', { jobId, phase: 'complete' });

        // Rebuild Apple Health sidecars + worksheets so Lists
        // and Patient Summary reflect the current KB contents.
        rebuildListsAfterIndexing();

        // Reload agent info to update KB info (including indexed files and connection status)
        if (currentTab.value === 'agent') {
          await loadAgent();
        }

        // Attach KB to agent (patient summary generation is disabled)
        await attachKBToAgentOnlyDuringIndexing();
        
        // Clear dirty flag since indexing completed successfully
        kbNeedsUpdate.value = false;
        
        // Clean up elapsed time interval
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
          indexingKB.value = false;
        }, 5000);
      } else if (statusResult.phase === 'error') {
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = statusResult.error || 'Indexing failed';
        emit('indexing-finished', { jobId, phase: 'error', error: indexingStatus.value.error });
        
        // Clean up elapsed time interval
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        
        $q.notify({
          type: 'negative',
          message: `Indexing failed: ${indexingStatus.value.error}`
        });
      }
    } catch (err) {
      clearInterval(pollingInterval.value!);
      pollingInterval.value = null;
      if (elapsedTimeInterval.value) {
        clearInterval(elapsedTimeInterval.value);
        elapsedTimeInterval.value = null;
      }
      indexingKB.value = false;
      indexingStatus.value.phase = 'error';
      indexingStatus.value.error = err instanceof Error ? err.message : 'Failed to get indexing status';
      emit('indexing-finished', { jobId, phase: 'error', error: indexingStatus.value.error });
      console.error('Error polling indexing status:', err);
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: `Error checking indexing status: ${indexingStatus.value.error}`
        });
      }
    }
  }, POLL_INTERVAL_MS);
};

// Chat management methods
const selectChat = async (chat: SavedChat) => {
  try {
    let response;
    
    // If chat has a shareId, load it via shareId endpoint (for deep links)
    if (chat.shareId) {
      response = await fetch(`/api/load-chat-by-share/${chat.shareId}`, {
      credentials: 'include'
    });
    } else {
      // Otherwise, load chat via chatId
      response = await fetch(`/api/load-chat/${chat._id}`, {
        credentials: 'include'
      });
    }
    
    if (!response.ok) {
      throw new Error(`Failed to load chat: ${response.statusText}`);
    }
    
    const result = await response.json();
    const closed = await closeDialog();
    if (closed) {
    emit('chat-selected', result.chat);
    }
  } catch (err) {
    console.error('Failed to load full chat data:', err);
    // Fallback: emit the chat we have
    const closed = await closeDialog();
    if (closed) {
    emit('chat-selected', chat);
    }
  }
};

const copyChatLink = (chat: SavedChat) => {
  if (!chat.shareId) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'Create a deep link by saving this chat first.',
        position: 'top',
        timeout: 2000
      });
    }
    return;
  }

  const baseUrl = window.location.origin;
  const link = `${baseUrl}/chat/${chat.shareId}`;

  navigator.clipboard.writeText(link)
    .then(() => {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: 'Deep link copied to clipboard',
          position: 'top',
          timeout: 3000,
          color: 'primary',
          textColor: 'white'
        });
      } else {
        alert('Deep link copied to clipboard');
      }
    })
    .catch(() => {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: 'Failed to copy link',
          position: 'top',
          timeout: 3000
        });
      } else {
        alert('Failed to copy link');
      }
    });
};

const confirmDeleteChat = (chat: SavedChat) => {
  if ($q && typeof $q.dialog === 'function') {
  $q.dialog({
    title: 'Delete Chat',
    message: 'Are you sure you want to delete this chat?',
    cancel: true,
    persistent: true
  }).onOk(() => {
    deleteChat(chat);
  });
  } else if (window.confirm('Are you sure you want to delete this chat?')) {
    deleteChat(chat);
  }
};

const deleteChat = async (chat: SavedChat) => {
  try {
    await deleteChatById(chat._id);

    // Remove from list
    sharedChats.value = sharedChats.value.filter(c => c._id !== chat._id);
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Chat deleted successfully'
    });
    }
  } catch (err) {
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to delete chat'
    });
    } else {
      console.error('Failed to delete chat:', err);
    }
  }
};

// Helper function to attach KB to agent
const attachKBToAgentOnly = async () => {
  const attachResponse = await fetch('/api/attach-kb-to-agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      userId: props.userId
    })
  });

  if (!attachResponse.ok) {
    const errorData = await attachResponse.json();
    throw new Error(errorData.message || 'Failed to attach KB to agent');
  }

  await attachResponse.json();
};

// Attach KB to agent (patient summary generation is disabled)
const attachKBToAgentOnlyDuringIndexing = async () => {
  try {
    // Keep indexing status visible and update message
    indexingStatus.value.message = 'Attaching knowledge base to agent...';
    emit('indexing-status-update', {
      jobId: currentIndexingJobId.value || '',
      phase: 'kb_setup',
      tokens: indexingStatus.value.tokens,
      filesIndexed: indexingStatus.value.filesIndexed,
      progress: 1.0
    });
    
    await attachKBToAgentOnly();
  } catch (error) {
    indexingStatus.value.message = `Error: ${error instanceof Error ? error.message : 'Failed to attach KB'}`;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to attach KB'
      });
    }
  }
};

// Handle confirmation to replace summary (before generation)
const handleConfirmReplaceSummary = async () => {
  showSummaryAvailableModal.value = false;
  isSummaryModalBeforeGeneration.value = false;
  if (pendingSummaryGeneration.value) {
    try {
      await pendingSummaryGeneration.value();
    } catch (error) {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: error instanceof Error ? error.message : 'Failed to generate patient summary'
        });
      }
    } finally {
      pendingSummaryGeneration.value = null;
    }
  }
};

// Handle replace summary by index (when all slots are full)
const handleReplaceSummaryByIndex = async (indexToReplace: number) => {
  showReplaceSummaryDialog.value = false;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: newSummaryToReplace.value,
        replaceIndex: indexToReplace
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to save patient summary');
    }

    await response.json(); // Response processed, but result not needed
    
    // Reload summaries to get updated list
    await loadPatientSummary();
    summaryNeedsVerify.value = true;
    emit('patient-summary-saved', { userId: props.userId, summary: patientSummary.value || '' });
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!',
        timeout: 3000
      });
    }
    
    newSummaryToReplace.value = '';
  } catch (error) {
    console.error('Error saving summary:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary',
        timeout: 5000
      });
    }
  }
};

// Handle replace summary dialog choice (for empty slots or keep strategy)
const handleReplaceSummary = async (replaceStrategy: 'keep' | 'oldest' | 'newest', summaryText?: string) => {
  showReplaceSummaryDialog.value = false;
  
  const summaryToSave = summaryText || newSummaryToReplace.value;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave,
        replaceStrategy: replaceStrategy
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to save patient summary');
    }

    await response.json(); // Response processed, but result not needed
    
    // Reload summaries to get updated list
    await loadPatientSummary();
    summaryNeedsVerify.value = true;
    emit('patient-summary-saved', { userId: props.userId, summary: patientSummary.value || '' });
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: replaceStrategy === 'keep' ? 'Current summary kept' : 'Patient summary saved successfully!',
        timeout: 3000
      });
    }
    
    newSummaryToReplace.value = '';
  } catch (error) {
    console.error('Error saving summary:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary',
        timeout: 5000
      });
    }
  }
};

// Handle closing the summary modal
const handleCloseSummaryModal = () => {
  showSummaryAvailableModal.value = false;
  if (isSummaryModalBeforeGeneration.value) {
    // If it was before generation, cancel the pending generation
    pendingSummaryGeneration.value = null;
    isSummaryModalBeforeGeneration.value = false;
  } else {
    // If it was after generation, close the dialog
    handleCloseMyStuff();
  }
};

// Patient Summary modal handlers
const handleSaveSummary = async () => {
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: newPatientSummary.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save patient summary');
    }

    // Update local summary
    patientSummary.value = newPatientSummary.value;
    summaryEditText.value = newPatientSummary.value;
    isEditingSummaryTab.value = false;
    summaryNeedsVerify.value = true;

    emit('patient-summary-saved', { userId: props.userId, summary: patientSummary.value || '' });
    
    showSummaryAvailableModal.value = false;
    if (showSummaryViewModal.value) {
      showSummaryViewModal.value = false;
    }
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary'
      });
    }
  }
};

const handleCloseMyStuff = () => {
  showSummaryAvailableModal.value = false;
  emit('update:modelValue', false);
};

const handleEditSummary = () => {
  editingSummary.value = true;
};

const handleSaveEditedSummary = async () => {
  const summaryToSave = editingSummary.value ? summaryViewText.value : newPatientSummary.value;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save patient summary');
    }

    // Update local values
    newPatientSummary.value = summaryToSave;
    patientSummary.value = summaryToSave;
    summaryEditText.value = summaryToSave;
    isEditingSummaryTab.value = false;
    editingSummary.value = false;
    showSummaryViewModal.value = false;
    
    emit('patient-summary-saved', { userId: props.userId, summary: patientSummary.value || '' });
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary'
      });
    }
  }
};

const handleCloseWithoutSaving = () => {
  if (editingSummary.value) {
    // Revert changes
    summaryViewText.value = newPatientSummary.value;
    editingSummary.value = false;
  } else {
    showSummaryViewModal.value = false;
  }
};

// Patient Summary methods
// Helper function to format time ago
const getTimeAgo = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffDays > 0) {
    return `${diffDays} ${diffDays === 1 ? 'day' : 'days'}`;
  } else if (diffHours > 0) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'}`;
  } else {
    return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'}`;
  }
};

// Swap summary function
const swapSummary = async (index: number) => {
  try {
    const response = await fetch('/api/patient-summary/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        index: index
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to swap summary');
    }

    await response.json(); // Response processed, but result not needed
    // Reload summaries
    await loadPatientSummary();
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Summary swapped successfully',
        timeout: 3000
      });
    }
  } catch (error) {
    console.error('Error swapping summary:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to swap summary',
        timeout: 5000
      });
    }
  }
};

// Strip leading titles (Dr, Dr., Mr, Mrs, Ms, Prof., RN, CNP, OD) for canonical name comparison
const stripNameTitles = (name: string): string => {
  const t = name
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutTitle = t.replace(
    /^(?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+/i,
    ''
  ).trim();
  return withoutTitle || t;
};

// Map last name (lowercase) -> full name from a list of names we already have (mapping originals or extracted).
// Used to resolve "Gropper" -> "Adrian Gropper" when we have "Adrian Gropper" in the mapping. First occurrence wins.
const buildLastNameToFullNameFromFullNames = (originals: string[]): Map<string, string> => {
  const m = new Map<string, string>();
  for (const orig of originals) {
    const full = stripNameTitles(orig);
    const parts = full.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1].toLowerCase();
      if (!m.has(last)) {
        m.set(last, full);
      }
    }
  }
  return m;
};

// Canonical form for one person: "First Last". Resolves "Last" / "Dr Last" to "First Last" when we have that full name in our map (from mapping or extracted names).
const toCanonical = (
  name: string,
  lastNameToFullName?: Map<string, string>
): string => {
  const stripped = stripNameTitles(name);
  const parts = stripped.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return parts.join(' ');
  }
  if (parts.length === 1 && lastNameToFullName) {
    const full = lastNameToFullName.get(parts[0].toLowerCase());
    if (full) return full;
  }
  return stripped;
};

// Helper function to deduplicate mapping (used both on load and when adding new names).
// If getCanonical is provided, two originals are treated as the same person when they share the same canonical name
// (e.g. "First Last", "Dr First Last", "Dr. Last" -> one entry with original "First Last").
const deduplicateMapping = (
  mappings: Array<{ original: string; pseudonym: string }>,
  getCanonical?: (original: string) => string
): {
  deduplicated: Array<{ original: string; pseudonym: string }>;
  removed: string[];
} => {
  const seen = new Set<string>();
  const deduplicatedMapping: Array<{ original: string; pseudonym: string }> = [];
  const duplicatesRemoved: string[] = [];

  // When using canonical form, process full names first so we keep "Adrian Gropper" over "Gropper" as the display original
  const toProcess = getCanonical
    ? [...mappings].sort((a, b) => {
        const wordsA = getCanonical(a.original).split(/\s+/).filter(Boolean).length;
        const wordsB = getCanonical(b.original).split(/\s+/).filter(Boolean).length;
        return wordsB - wordsA;
      })
    : mappings;

  for (const mapping of toProcess) {
    const key = getCanonical
      ? getCanonical(mapping.original).replace(/\s+/g, ' ').trim().toLowerCase()
      : mapping.original
          .replace(/\u00A0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      const displayOriginal = getCanonical ? getCanonical(mapping.original) : mapping.original;
      deduplicatedMapping.push({
        original: displayOriginal,
        pseudonym: mapping.pseudonym
      });
    } else {
      duplicatesRemoved.push(mapping.original);
    }
  }

  return { deduplicated: deduplicatedMapping, removed: duplicatesRemoved };
};

// Remove single-word mappings that are the first name of a full-name mapping (e.g. keep "Roger Pasinski", remove "Roger").
const dropOrphanFirstNames = (
  mappings: Array<{ original: string; pseudonym: string }>
): Array<{ original: string; pseudonym: string }> => {
  const firstNamesOfFullNames = new Set(
    mappings
      .filter((m) => m.original.split(/\s+/).length >= 2)
      .map((m) => m.original.split(/\s+/)[0].toLowerCase())
  );
  return mappings.filter((m) => {
    const parts = m.original.split(/\s+/);
    if (parts.length === 1 && firstNamesOfFullNames.has(parts[0].toLowerCase())) {
      return false;
    }
    return true;
  });
};

const loadPrivacyFilter = async () => {
  loadingPrivacyFilter.value = true;
  privacyFilterError.value = '';
  privacyFilterResponse.value = '';

  try {
    // Build last-name -> full-name from the mapping we load (so "Gropper" merges with "Adrian Gropper")
    const getCanonicalFromMapping = (mapping: Array<{ original: string; pseudonym: string }>) => {
      const lastNameToFullName = buildLastNameToFullNameFromFullNames(mapping.map(m => m.original));
      return (orig: string) => toCanonical(orig, lastNameToFullName);
    };

    // Always try to load existing mapping first (cumulative - never deleted)
    try {
      const loadResponse = await fetch('/api/privacy-filter-mapping', {
        credentials: 'include'
      });

      if (!loadResponse.ok) {
        privacyFilterMapping.value = [];
      } else {
        const loadData = await loadResponse.json();
        if (loadData.mapping && loadData.mapping.length > 0) {
          const { deduplicated, removed } = deduplicateMapping(loadData.mapping, getCanonicalFromMapping(loadData.mapping));
          const cleaned = dropOrphanFirstNames(deduplicated);

          if (removed.length > 0 || cleaned.length !== deduplicated.length) {
            try {
              await fetch('/api/privacy-filter-mapping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ mapping: cleaned })
              });
            } catch (saveErr) {
              // Silently handle save errors
            }
          }

          privacyFilterMapping.value = cleaned;
        } else {
          const mapping = loadData.mapping || [];
          const { deduplicated } = deduplicateMapping(mapping, getCanonicalFromMapping(mapping));
          privacyFilterMapping.value = dropOrphanFirstNames(deduplicated);
        }
      }
    } catch (loadErr) {
      privacyFilterMapping.value = [];
    }

    // Always run deduplication on the current mapping value (in case it was set elsewhere)
    if (privacyFilterMapping.value.length > 0) {
      const current = privacyFilterMapping.value;
      const { deduplicated, removed } = deduplicateMapping(current, getCanonicalFromMapping(current));
      const cleaned = dropOrphanFirstNames(deduplicated);
      if (removed.length > 0 || cleaned.length !== privacyFilterMapping.value.length) {
        privacyFilterMapping.value = cleaned;
        try {
          await fetch('/api/privacy-filter-mapping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ mapping: cleaned })
          });
        } catch (saveErr) {
          // Silently handle save errors
        }
      }
    }

    // Use originalMessages if available (unfiltered), otherwise fall back to props.messages
    const allMessages = (props.originalMessages && props.originalMessages.length > 0) 
      ? props.originalMessages 
      : props.messages;
    
    // Include EVERY user and assistant message in the name-extraction
    // pass, regardless of which provider authored it. The previous
    // filter (Private AI assistant messages only — `providerKey ===
    // 'digitalocean'` / `authorLabel === 'Private AI'`) became
    // load-bearing after the v1.4.0 Patient Summary overhaul:
    // post-overhaul assistant messages carry labels like
    // "Private AI (GPT)" / "Private AI (Deepseek)" and PS-routed /
    // lab-history-routed messages set their own labels too. Public-AI
    // responses (Anthropic, ChatGPT, public Deepseek) also legitimately
    // contain patient names that need redacting. Excluding any of
    // those from the analyze pass means their names are never added
    // to `privacyFilterMapping`, so the subsequent replace pass has
    // nothing to substitute — the user sees an unchanged chat.
    // Including everything is also strictly safer: hiding any chat
    // content from the redaction extractor leaks names, never the
    // reverse.
    const messagesToAnalyze = allMessages.filter(msg =>
      msg.role === 'user' || msg.role === 'assistant'
    );
    
    // Check if we have messages to query Private AI
    if (!messagesToAnalyze || messagesToAnalyze.length === 0) {
      // Still show existing mapping if available - don't set error if mapping exists
      if (privacyFilterMapping.value.length === 0) {
        privacyFilterError.value = 'No Private AI chat messages available';
      }
      return;
    }

    // Prepare messages for Private AI query
    // Include only Private AI chat messages plus the privacy filter question
    // IMPORTANT: We only want names from the chat messages themselves, not from knowledge base documents
    const chatMessagesOnly = messagesToAnalyze.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
    
    const queryMessages = [
      ...chatMessagesOnly,
      {
        role: 'user' as const,
        content: 'Based ONLY on the chat messages above (ignore any information from your knowledge base or retrieved documents), what names of people are explicitly mentioned in this chat conversation? List only names that appear in the chat messages themselves.'
      }
    ];

    // Query Private AI
    const response = await fetch('/api/chat/digitalocean', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      credentials: 'include',
      body: JSON.stringify({
        messages: queryMessages,
        options: {
          stream: true
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || 'Failed to query Private AI');
    }

    // Read streaming response
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let responseText = '';

    if (!reader) {
      throw new Error('Failed to read response stream');
    }

    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      
      // Process complete lines (ending with \n\n)
      const lines = buffer.split('\n\n');
      // Keep the last incomplete line in buffer
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            
            // Only use delta for incremental content (like ChatInterface does)
            // Ignore content field to avoid duplication
            if (data.delta) {
              responseText += data.delta;
            }
            
            // Check if response is complete
            if (data.isComplete) {
              break;
            }
          } catch (e) {
            // Skip malformed JSON - might be partial chunk
          }
        }
      }
    }
    
    // Store the raw response
    privacyFilterResponse.value = responseText.trim();
    
    // Always check for new names and add them to existing mapping (cumulative)
    await createPseudonymMapping(responseText.trim());
  } catch (err) {
    privacyFilterError.value = err instanceof Error ? err.message : 'Failed to analyze chat for names';
  } finally {
    loadingPrivacyFilter.value = false;
  }
};

const createPseudonymMapping = async (responseText: string) => {
  loadingRandomNames.value = true;
  
  try {
    // Load random names from backend API (empty list if endpoint missing or fails)
    let randomNamesList: string[] = [];
    try {
      const randomNamesResponse = await fetch('/api/random-names');
      if (randomNamesResponse.ok) {
        const randomNamesData = await randomNamesResponse.json();
        randomNamesList = randomNamesData.names || [];
      }
    } catch (_) {
      randomNamesList = [];
    }
    
    // Parse names from Privacy Filter response (robust to formatting: bullets, tables, headers)
    // 1) Normalize: strip markdown list/header prefixes, then collect line content and table cells
    const rawLines = responseText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const nameCandidates: string[] = [];
    for (const line of rawLines) {
      const stripped = line
        .replace(/^\s*#+\s*/, '')           // ## Header
        .replace(/^\s*[-*]\s*/, '')        // - or * bullet
        .replace(/^\s*\d+[.)]\s*/, '')     // 1. or 1) numbered list
        .trim();
      if (!stripped) continue;
      if (stripped.includes('|')) {
        const cells = stripped.split('|').map(c => c.trim()).filter(Boolean);
        nameCandidates.push(...cells);
      } else {
        nameCandidates.push(stripped);
      }
    }

    const namePatterns = [
      /^(?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/,
      /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/,
      /^(?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?)\s+([A-Z][a-z]+)/,
      /^([A-Z][a-z]+)$/
    ];

    const skipWords = new Set(['name', 'role', 'patient', 'column']);
    const titleWords = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'rn', 'cnp', 'od']);
    const extractedNames: string[] = [];
    const initialLastNamePattern = /\b([A-Z])\.\s+([A-Z][a-z]+)(?:\s|$|,)/g; // "C. Pasinski" or "X. LastName,"
    for (const candidate of nameCandidates) {
      const cleanLine = candidate.replace(/\s*\([^)]*\)/g, '').trim();
      if (!cleanLine) continue;
      for (const pattern of namePatterns) {
        const match = cleanLine.match(pattern);
        if (match) {
          const name = match[1] || match[0];
          if (name && name.length > 1 && !skipWords.has(name.toLowerCase())) {
            extractedNames.push(name);
            if (pattern === namePatterns[0] && match[0] !== name) {
              extractedNames.push(match[0]);
            }
            break;
          }
        }
      }
      // Also extract last names after middle initial; if a first name precedes "X. LastName", use full name to avoid separate mappings
      let initialMatch;
      initialLastNamePattern.lastIndex = 0;
      while ((initialMatch = initialLastNamePattern.exec(cleanLine)) !== null) {
        const lastName = initialMatch[2];
        if (!lastName || lastName.length <= 1 || skipWords.has(lastName.toLowerCase())) continue;
        const beforeInitial = cleanLine.substring(0, initialMatch.index).trim();
        const wordsBefore = beforeInitial.split(/\s+/).filter(Boolean);
        const lastWord = wordsBefore.length > 0 ? wordsBefore[wordsBefore.length - 1] : '';
        const looksLikeFirstName = lastWord && /^[A-Z][a-z]+$/.test(lastWord) && !titleWords.has(lastWord.toLowerCase()) && !skipWords.has(lastWord.toLowerCase());
        if (looksLikeFirstName) {
          extractedNames.push(`${lastWord} ${lastName}`);
        } else {
          extractedNames.push(lastName);
        }
      }
    }
    
    // Remove duplicates from extracted names (case-insensitive)
    const seenExtracted = new Set<string>();
    const uniqueExtractedNames: string[] = [];
    for (const name of extractedNames) {
      const key = name.toLowerCase();
      if (!seenExtracted.has(key)) {
        seenExtracted.add(key);
        uniqueExtractedNames.push(name);
      }
    }
    
    // Resolve "Last" -> "First Last" using names we already have (mapping + extracted), not Random Names
    const lastNameToFullName = buildLastNameToFullNameFromFullNames([
      ...(privacyFilterMapping.value || []).map(m => m.original),
      ...uniqueExtractedNames
    ]);
    const getCanonicalForMerge = (orig: string) => toCanonical(orig, lastNameToFullName);

    // Start with existing mapping (cumulative - never delete)
    const existingMapping = privacyFilterMapping.value || [];
    const existingCanonicals = new Set(
      existingMapping.map(m => getCanonicalForMerge(m.original).toLowerCase())
    );

    // One mapping per person: convert each extracted name to canonical "First Last" (or "Last" -> resolved to "First Last" via Random Names)
    const newNames: string[] = [];
    for (const name of uniqueExtractedNames) {
      const canonical = toCanonical(name, lastNameToFullName);
      const key = canonical.toLowerCase();
      if (!existingCanonicals.has(key) && !newNames.some(n => n.toLowerCase() === key)) {
        newNames.push(canonical);
      }
    }
    if (newNames.length === 0) {
      return; // No new names, keep existing mapping
    }
    
    // Create pseudonym mapping for new names only
    const newMappings: Array<{ original: string; pseudonym: string }> = [];
    const usedRandomNames = new Set<number>();
    
    // Track which random names are already used in existing mapping
    existingMapping.forEach((m: { original: string; pseudonym: string }) => {
      // Extract the random name from pseudonym (e.g., "Emily45 Johnson67" -> "Emily Johnson")
      const pseudonymParts = m.pseudonym.split(/\s+/);
      if (pseudonymParts.length >= 2) {
        const firstName = pseudonymParts[0].replace(/\d+$/, ''); // Remove trailing numbers
        const lastName = pseudonymParts[1].replace(/\d+$/, ''); // Remove trailing numbers
        const randomName = `${firstName} ${lastName}`;
        const index = randomNamesList.findIndex((name: string) => name === randomName);
        if (index >= 0) {
          usedRandomNames.add(index);
        }
      }
    });
    
    for (const originalName of newNames) {
      // Pick a random name from the list (without replacement to avoid duplicates)
      let randomIndex: number;
      let attempts = 0;
      do {
        randomIndex = Math.floor(Math.random() * randomNamesList.length);
        attempts++;
        // If we've used all names, reset (allow reuse)
        if (attempts > randomNamesList.length * 2) {
          usedRandomNames.clear();
          break;
        }
      } while (usedRandomNames.has(randomIndex));
      
      usedRandomNames.add(randomIndex);
      const randomName = randomNamesList[randomIndex];
      
      // Split into first and last name
      const nameParts = randomName.split(/\s+/);
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || nameParts[1] || '';
      
      // Generate random numbers (10-99) for first and last name
      const firstNum = Math.floor(Math.random() * 90) + 10; // 10-99
      const lastNum = Math.floor(Math.random() * 90) + 10; // 10-99
      
      // Create pseudonym: "FirstNameXX LastNameYY"
      const pseudonym = lastName 
        ? `${firstName}${firstNum} ${lastName}${lastNum}`
        : `${firstName}${firstNum}`;
      
      // Validate pseudonym before adding
      if (!pseudonym || pseudonym.trim() === '') {
        continue; // Skip this name
      }
      
      newMappings.push({ original: originalName, pseudonym });
    }
    
    // Merge new mappings with existing ones; deduplicate by canonical name so "Dr First Last" and "First Last" become one entry
    const allMappings = [...existingMapping, ...newMappings];
    const { deduplicated: deduplicatedMapping, removed: duplicateRemoved } = deduplicateMapping(
      allMappings,
      getCanonicalForMerge
    );

    const mappingWithoutOrphanFirstNames = dropOrphanFirstNames(deduplicatedMapping);
    
    privacyFilterMapping.value = mappingWithoutOrphanFirstNames;
    
    // Always save the deduplicated mapping to ensure storage is clean
    if (duplicateRemoved.length > 0 || newMappings.length > 0 || mappingWithoutOrphanFirstNames.length !== deduplicatedMapping.length) {
      try {
        await fetch('/api/privacy-filter-mapping', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({ mapping: mappingWithoutOrphanFirstNames })
        });
        // Silently handle save errors
      } catch (saveErr) {
        // Silently handle save errors
      }
    }
    
    // Save updated mapping to user document
    try {
      await fetch('/api/privacy-filter-mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ mapping: mappingWithoutOrphanFirstNames })
      });
      
        // Silently handle save errors
      } catch (saveErr) {
        // Don't fail the whole operation if save fails
      }
  } catch (err) {
    privacyFilterMapping.value = [];
  } finally {
    loadingRandomNames.value = false;
  }
};

const filterCurrentChat = () => {
  // Prefer originalMessages (truly original unfiltered) if available, otherwise use props.messages
  // The condition checks if originalMessages exists and has content
  // IMPORTANT: props.originalMessages is trulyOriginalMessages from ChatInterface, which is never filtered
  const messagesToFilter = (props.originalMessages && props.originalMessages.length > 0) 
    ? props.originalMessages 
    : (props.messages && props.messages.length > 0 ? props.messages : []);
  
  if (!messagesToFilter || messagesToFilter.length === 0) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'No chat messages available to filter',
        timeout: 3000
      });
    }
    return;
  }
  
  if (privacyFilterMapping.value.length === 0) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'No pseudonym mapping available. Please analyze the chat first.',
        timeout: 3000
      });
    }
    return;
  }
  
  // Track which names were pseudonymized
  const pseudonymizedNames: Array<{ original: string; pseudonym: string }> = [];
  
  // Filter ALL messages in the current chat — user messages, Private AI, and public AI responses.
  // The chat may be loaded from a saved chat, and real names can appear in any message
  // (introduced by the user, deep link context, or any AI provider).
  // NOTE: In the future, public AIs may gain direct KB or tool-call access to MAIA,
  // making it even more important that filtering covers all provider responses.
  const filteredMessageCount = messagesToFilter.length;

  // Create filtered messages by replacing names with pseudonyms in every message
  const filteredMessages: Message[] = messagesToFilter.map(msg => {
    let filteredContent = msg.content;
    
    // Build enhanced mappings that include variations with titles
    const enhancedMappings: Array<{ 
      original: string; 
      pseudonym: string; 
      lastName: string | null;
      lastNamePseudonym: string | null;
      isFullName: boolean;
    }> = [];
    // Match with or without period: Dr, Dr., Mr, Mr., etc.
    const titles = ['Dr\\.?', 'Mr\\.?', 'Mrs\\.?', 'Ms\\.?', 'Prof\\.?', 'RN', 'CNP', 'OD'];
    
    for (const mapping of privacyFilterMapping.value) {
      const original = mapping.original;
      const pseudonym = mapping.pseudonym;
      
      // Validate pseudonym before using it
      if (!pseudonym || typeof pseudonym !== 'string' || pseudonym.trim() === '') {
        continue; // Skip this mapping
      }
      
      // Extract last name if this is a full name
      const nameParts = original.split(/\s+/);
      const isFullName = nameParts.length >= 2;
      const lastName = isFullName ? nameParts[nameParts.length - 1] : null;
      
      // Find pseudonym for last name (if this is a full name, extract last name part from pseudonym)
      let lastNamePseudonym: string | null = null;
      if (isFullName && lastName) {
        const pseudonymParts = pseudonym.split(/\s+/);
        if (pseudonymParts.length >= 2) {
          lastNamePseudonym = pseudonymParts[pseudonymParts.length - 1]; // Last part of pseudonym
        }
      }
      
      enhancedMappings.push({ 
        original, 
        pseudonym, 
        lastName,
        lastNamePseudonym,
        isFullName
      });
    }
    
    // Sort by length (longest first) to avoid partial replacements
    // (e.g., "John Smith" before "John")
    enhancedMappings.sort((a, b) => b.original.length - a.original.length);
    
    // Track changes for full name replacements
    const beforeFullNameReplace = filteredContent;
    
    // Apply replacements for each mapping (full names first)
    for (const mapping of enhancedMappings) {
      // Normalize the original name: replace Unicode spaces with regular space
      const normalizedOriginal = mapping.original
        .replace(/\u202F/g, ' ')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Escape each word and join with \s+ so we match any whitespace (including U+202F, U+00A0) between first/last name.
      // This fixes "Dr. Wei Lien" not matching when the source has a narrow no-break space, which would leave only last-name replacement (e.g. "Dr. Wei Edwards89").
      const nameParts = normalizedOriginal.split(/\s+/).filter(Boolean);
      const escapedOriginal = nameParts
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+');
      const escapedOriginalWithUnicode =
        nameParts.length === 0
          ? escapedOriginal
          : mapping.original
              .split(/\s+/)
              .filter(Boolean)
              .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('\\s+');

      // Pattern 1: Exact match (case-insensitive, word boundaries, any whitespace between words)
      const exactPattern = new RegExp(`\\b${escapedOriginal}\\b`, 'gi');
      const exactPatternUnicode =
        escapedOriginal !== escapedOriginalWithUnicode
          ? new RegExp(`\\b${escapedOriginalWithUnicode}\\b`, 'gi')
          : null;

      // Pattern 1b: FirstName X. LastName (middle initial) so "Roger C. Pasinski" matches mapping "Roger Pasinski"
      if (nameParts.length >= 2) {
        const escapedFirst = nameParts[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedRest = nameParts.slice(1).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
        const middleInitialPattern = new RegExp(`\\b${escapedFirst}\\s+[A-Z]\\.\\s+${escapedRest}\\b`, 'gi');
        filteredContent = filteredContent.replace(middleInitialPattern, () => mapping.pseudonym);
      }
      
      // Try both patterns (normalized and with Unicode spaces)
      filteredContent = filteredContent.replace(exactPattern, (match, offset) => {
        // Check if this match is inside markdown formatting
        const before = filteredContent.substring(Math.max(0, offset - 10), offset);
        const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 10));
        
        // Check for markdown bold/italic before: ** or * or ##
        const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
        // Check for markdown after: ** or * or comma/age info
        const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
        
        if (hasMarkdownBefore || hasMarkdownAfter) {
          // Name is already inside markdown (e.g. **Name**). We only replace the
          // matched name; the ** before/after are outside the match and stay.
          // Return just the pseudonym so we get "... **" + pseudonym + "** ...".
          return mapping.pseudonym;
        }
        return mapping.pseudonym;
      });
      
      // Also try matching with Unicode spaces if different
      if (exactPatternUnicode) {
        filteredContent = filteredContent.replace(exactPatternUnicode, (match, offset) => {
          const before = filteredContent.substring(Math.max(0, offset - 10), offset);
          const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 10));
          const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
          const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
          
          if (hasMarkdownBefore || hasMarkdownAfter) {
            return mapping.pseudonym;
          }
          return mapping.pseudonym;
        });
      }
      
      // Pattern 2: With titles (e.g., "Dr. Adrian Gropper", "Mr. Gropper")
      // Preserve the title in the replacement, and handle markdown
      // Use normalized original for matching
      for (const title of titles) {
        const titlePattern = new RegExp(`\\b${title}\\s+${escapedOriginal}\\b`, 'gi');
        const titlePatternUnicode = exactPatternUnicode 
          ? new RegExp(`\\b${title}\\s+${escapedOriginalWithUnicode}\\b`, 'gi')
          : null;
        
        filteredContent = filteredContent.replace(titlePattern, (match, offset) => {
          const titleMatch = match.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+/i);
          const replacement = titleMatch ? `${titleMatch[1]} ${mapping.pseudonym}` : mapping.pseudonym;
          
          // Check for markdown formatting
          const before = filteredContent.substring(Math.max(0, offset - 5), offset);
          const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
          const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
          const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
          
          if (hasMarkdownBefore || hasMarkdownAfter) {
            // Title+name is already inside markdown; only replace the matched span.
            return replacement;
          }
          return replacement;
        });
        
        // Also try with Unicode spaces
        if (titlePatternUnicode) {
          filteredContent = filteredContent.replace(titlePatternUnicode, (match, offset) => {
            const titleMatch = match.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+/i);
            const replacement = titleMatch ? `${titleMatch[1]} ${mapping.pseudonym}` : mapping.pseudonym;
            
            const before = filteredContent.substring(Math.max(0, offset - 5), offset);
            const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
            const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
            const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
            
            if (hasMarkdownBefore || hasMarkdownAfter) {
              return replacement;
            }
            return replacement;
          });
        }
      }
      
      // Pattern 3: Names in markdown formatting (e.g., "**Adrian Gropper, 73 M**")
      // This handles the full markdown-wrapped name
      // Use normalized version for matching
      const markdownPatterns = [
        new RegExp(`\\*\\*${escapedOriginal}([^\\*]*?)\\*\\*`, 'gi'), // **Name, info**
        new RegExp(`\\*${escapedOriginal}([^\\*]*?)\\*`, 'gi'), // *Name, info*
        new RegExp(`##\\s+${escapedOriginal}(.*?)(?:\\n|$)`, 'gi'), // ## Name info
      ];
      
      // Also create patterns for Unicode version if different
      const markdownPatternsUnicode = exactPatternUnicode ? [
        new RegExp(`\\*\\*${escapedOriginalWithUnicode}([^\\*]*?)\\*\\*`, 'gi'),
        new RegExp(`\\*${escapedOriginalWithUnicode}([^\\*]*?)\\*`, 'gi'),
        new RegExp(`##\\s+${escapedOriginalWithUnicode}(.*?)(?:\\n|$)`, 'gi'),
      ] : [];
      
      for (const mdPattern of markdownPatterns) {
        filteredContent = filteredContent.replace(mdPattern, (match, suffix) => {
          // Preserve the markdown formatting and any suffix (like ", 73 M")
          if (match.startsWith('**')) {
            return `**${mapping.pseudonym}${suffix || ''}**`;
          } else if (match.startsWith('*')) {
            return `*${mapping.pseudonym}${suffix || ''}*`;
          } else if (match.startsWith('##')) {
            return `## ${mapping.pseudonym}${suffix || ''}`;
          }
          return mapping.pseudonym + (suffix || '');
        });
      }
      
      // Also try Unicode patterns
      for (const mdPattern of markdownPatternsUnicode) {
        filteredContent = filteredContent.replace(mdPattern, (match, suffix) => {
          if (match.startsWith('**')) {
            return `**${mapping.pseudonym}${suffix || ''}**`;
          } else if (match.startsWith('*')) {
            return `*${mapping.pseudonym}${suffix || ''}*`;
          } else if (match.startsWith('##')) {
            return `## ${mapping.pseudonym}${suffix || ''}`;
          }
          return mapping.pseudonym + (suffix || '');
        });
      }
    }
    
    // Track which full names were replaced
    if (beforeFullNameReplace !== filteredContent) {
      for (const mapping of enhancedMappings) {
        const escapedOriginal = mapping.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const testPattern = new RegExp(`\\b${escapedOriginal}\\b`, 'gi');
        if (testPattern.test(beforeFullNameReplace) && !pseudonymizedNames.some(n => n.original === mapping.original)) {
          pseudonymizedNames.push({ original: mapping.original, pseudonym: mapping.pseudonym });
        }
      }
    }
    
    // Second pass: Process last names only (for full names that were mapped)
    // This avoids replacing last names that are part of already-replaced full names
    const lastNameMappings: Array<{ lastName: string; lastNamePseudonym: string; normalizedLastName: string }> = [];
    for (const mapping of enhancedMappings) {
      if (mapping.isFullName && mapping.lastName && mapping.lastNamePseudonym) {
        // Normalize last name (handle Unicode spaces)
        const normalizedLastName = mapping.lastName
          .replace(/\u202F/g, ' ')
          .replace(/\u00A0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        
        // Check if this last name mapping is unique (by normalized name)
        if (!lastNameMappings.some(m => m.normalizedLastName.toLowerCase() === normalizedLastName.toLowerCase())) {
          lastNameMappings.push({
            lastName: mapping.lastName,
            lastNamePseudonym: mapping.lastNamePseudonym,
            normalizedLastName: normalizedLastName
          });
        }
      }
    }
    
    // Apply last name replacements (only if they haven't been replaced as part of full names)
    for (const lastNameMapping of lastNameMappings) {
      // Use normalized last name for matching
      const escapedLastName = lastNameMapping.normalizedLastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedLastNameUnicode = lastNameMapping.lastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      // Match standalone last name (with word boundaries, case-insensitive)
      // Also handle markdown formatting
      // Try both normalized and Unicode versions
      const lastNamePattern = new RegExp(`\\b${escapedLastName}\\b`, 'gi');
      const lastNamePatternUnicode = escapedLastName !== escapedLastNameUnicode
        ? new RegExp(`\\b${escapedLastNameUnicode}\\b`, 'gi')
        : null;
      
      filteredContent = filteredContent.replace(lastNamePattern, (match, offset) => {
        // Check if this is part of a pseudonym (has numbers nearby) - if so, skip
        const before = filteredContent.substring(Math.max(0, offset - 5), offset);
        const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
        if (/\d/.test(before + after)) {
          return match; // Part of pseudonym, don't replace
        }
        
        // Check for markdown formatting
        const beforeFull = filteredContent.substring(Math.max(0, offset - 10), offset);
        const afterFull = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 10));
        const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(beforeFull);
        const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(afterFull);
        
        if (hasMarkdownBefore || hasMarkdownAfter) {
          return lastNameMapping.lastNamePseudonym;
        }
        
        return lastNameMapping.lastNamePseudonym;
      });
      
      // Also try Unicode version
      if (lastNamePatternUnicode) {
        filteredContent = filteredContent.replace(lastNamePatternUnicode, (match, offset) => {
          const before = filteredContent.substring(Math.max(0, offset - 5), offset);
          const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
          if (/\d/.test(before + after)) {
            return match;
          }
          
          const beforeFull = filteredContent.substring(Math.max(0, offset - 10), offset);
          const afterFull = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 10));
          const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(beforeFull);
          const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(afterFull);
          
          if (hasMarkdownBefore || hasMarkdownAfter) {
            return lastNameMapping.lastNamePseudonym;
          }
          
          return lastNameMapping.lastNamePseudonym;
        });
      }
      
      // Match last name with titles
      for (const title of titles) {
        const titleLastNamePattern = new RegExp(`\\b${title}\\s+${escapedLastName}\\b`, 'gi');
        const titleLastNamePatternUnicode = lastNamePatternUnicode
          ? new RegExp(`\\b${title}\\s+${escapedLastNameUnicode}\\b`, 'gi')
          : null;
        filteredContent = filteredContent.replace(titleLastNamePattern, (match, offset) => {
          const titleMatch = match.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+/i);
          const replacement = titleMatch ? `${titleMatch[1]} ${lastNameMapping.lastNamePseudonym}` : lastNameMapping.lastNamePseudonym;
          
          // Check for markdown formatting
          const before = filteredContent.substring(Math.max(0, offset - 5), offset);
          const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
          const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
          const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
          
          if (hasMarkdownBefore || hasMarkdownAfter) {
            return replacement;
          }
          return replacement;
        });
        
        // Also try Unicode version
        if (titleLastNamePatternUnicode) {
          filteredContent = filteredContent.replace(titleLastNamePatternUnicode, (match, offset) => {
            const titleMatch = match.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+/i);
            const replacement = titleMatch ? `${titleMatch[1]} ${lastNameMapping.lastNamePseudonym}` : lastNameMapping.lastNamePseudonym;
            
            const before = filteredContent.substring(Math.max(0, offset - 5), offset);
            const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
            const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
            const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
            
            if (hasMarkdownBefore || hasMarkdownAfter) {
              return replacement;
            }
            return replacement;
          });
        }
      }
      
      // Match "Mr./Ms. LastName" format (with period)
      const titlePeriodPattern = new RegExp(`\\b(Mr|Ms|Mrs|Dr|Prof)\\.\\s+${escapedLastName}\\b`, 'gi');
      const titlePeriodPatternUnicode = lastNamePatternUnicode
        ? new RegExp(`\\b(Mr|Ms|Mrs|Dr|Prof)\\.\\s+${escapedLastNameUnicode}\\b`, 'gi')
        : null;
      filteredContent = filteredContent.replace(titlePeriodPattern, (match, offset) => {
        const titleMatch = match.match(/^(Mr|Ms|Mrs|Dr|Prof)\./i);
        const replacement = titleMatch ? `${titleMatch[1]}. ${lastNameMapping.lastNamePseudonym}` : lastNameMapping.lastNamePseudonym;
        
        // Check for markdown formatting
        const before = filteredContent.substring(Math.max(0, offset - 5), offset);
        const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
        const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
        const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
        
        if (hasMarkdownBefore || hasMarkdownAfter) {
          return replacement;
        }
        return replacement;
      });
      
      // Also try Unicode version
      if (titlePeriodPatternUnicode) {
        filteredContent = filteredContent.replace(titlePeriodPatternUnicode, (match, offset) => {
          const titleMatch = match.match(/^(Mr|Ms|Mrs|Dr|Prof)\./i);
          const replacement = titleMatch ? `${titleMatch[1]}. ${lastNameMapping.lastNamePseudonym}` : lastNameMapping.lastNamePseudonym;
          
          const before = filteredContent.substring(Math.max(0, offset - 5), offset);
          const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
          const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
          const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
          
          if (hasMarkdownBefore || hasMarkdownAfter) {
            return replacement;
          }
          return replacement;
        });
      }
      
      // Pattern for last names in markdown formatting (e.g., "**Mr. Gropper**")
      const lastNameMarkdownPatterns = [
        new RegExp(`\\*\\*([^\\*]*?\\s+)?${escapedLastName}([^\\*]*?)\\*\\*`, 'gi'), // **prefix LastName suffix**
        new RegExp(`\\*([^\\*]*?\\s+)?${escapedLastName}([^\\*]*?)\\*`, 'gi'), // *prefix LastName suffix*
      ];
      
      for (const mdPattern of lastNameMarkdownPatterns) {
        filteredContent = filteredContent.replace(mdPattern, (match, prefix, suffix) => {
          const prefixText = prefix || '';
          const suffixText = suffix || '';
          if (match.startsWith('**')) {
            return `**${prefixText}${lastNameMapping.lastNamePseudonym}${suffixText}**`;
          } else if (match.startsWith('*')) {
            return `*${prefixText}${lastNameMapping.lastNamePseudonym}${suffixText}*`;
          }
          return prefixText + lastNameMapping.lastNamePseudonym + suffixText;
        });
      }
    }

    // Filename-variant pass: catch ALL-CAPS underscore-separated names in file legend footers
    // e.g. GROPPER_ADRIAN in "GROPPER_ADRIAN_05-12-2026_to2016.PDF"
    for (const mapping of enhancedMappings) {
      if (!mapping.isFullName || !mapping.lastName) continue;
      const nameParts = mapping.original.split(/\s+/).filter(Boolean);
      if (nameParts.length < 2) continue;
      const firstName = nameParts[0];
      const lastName = mapping.lastName;
      const pseudonymParts = mapping.pseudonym.split(/\s+/).filter(Boolean);
      const pseudoFirst = pseudonymParts[0] || mapping.pseudonym;
      const pseudoLast = pseudonymParts.length >= 2 ? pseudonymParts[pseudonymParts.length - 1] : pseudoFirst;

      // LASTNAME_FIRSTNAME and FIRSTNAME_LASTNAME (case-insensitive)
      const lastFirst = new RegExp(`${lastName}[_\\s]${firstName}`, 'gi');
      const firstLast = new RegExp(`${firstName}[_\\s]${lastName}`, 'gi');
      filteredContent = filteredContent.replace(lastFirst, `${pseudoLast}_${pseudoFirst}`);
      filteredContent = filteredContent.replace(firstLast, `${pseudoFirst}_${pseudoLast}`);

      // Standalone ALL-CAPS last name adjacent to underscore/dot (filename context)
      const lastNameUpper = lastName.toUpperCase();
      if (lastNameUpper.length >= 3) {
        const filenameLast = new RegExp(`(?<=[_./])${lastNameUpper}(?=[_./])`, 'g');
        filteredContent = filteredContent.replace(filenameLast, pseudoLast.toUpperCase());
      }
      // Standalone ALL-CAPS first name adjacent to underscore/dot (filename context)
      const firstNameUpper = firstName.toUpperCase();
      if (firstNameUpper.length >= 3) {
        const filenameFirst = new RegExp(`(?<=[_./])${firstNameUpper}(?=[_./])`, 'g');
        filteredContent = filteredContent.replace(filenameFirst, pseudoFirst.toUpperCase());
      }
    }

    return {
      ...msg,
      content: filteredContent
    };
  });

  // Check if any names were actually replaced
  const namesReplaced = pseudonymizedNames.length > 0;
  
  // Compare filtered messages with original to see if anything changed
  let hasChanges = false;
  for (let i = 0; i < filteredMessages.length && i < messagesToFilter.length; i++) {
    if (filteredMessages[i].content !== messagesToFilter[i].content) {
      hasChanges = true;
      break;
    }
  }
  
  // Check if messages might already be filtered (contain pseudonyms with numbers)
  const mightBeFiltered = messagesToFilter.some(msg => {
    // Check if message contains patterns like "Name45" or "Name67" (pseudonym pattern)
    return /\b[A-Z][a-z]+\d{2}\s+[A-Z][a-z]+\d{2}\b/.test(msg.content);
  });
  
  if (!hasChanges && !namesReplaced) {
    // Self-diagnosing toast: tell the user EXACTLY what the filter
    // saw so the next "doesn't replace" bug report comes with the
    // information needed to find the root cause. The two common
    // failure modes are (a) the mapping has names that don't appear
    // in the chat content (extraction ran on different messages than
    // the user is now viewing), or (b) the chat is already filtered.
    if ($q && typeof $q.notify === 'function') {
      const mappingPreview = (privacyFilterMapping.value || [])
        .slice(0, 5)
        .map(m => m.original)
        .filter(Boolean)
        .join(', ');
      const messageCount = messagesToFilter.length;
      const mappingCount = (privacyFilterMapping.value || []).length;
      const detail = mightBeFiltered
        ? `Messages appear to already be filtered. Use truly original messages to re-filter. (${mappingCount} mappings, ${messageCount} messages scanned)`
        : `Privacy Filter found no matches.\n` +
          `• ${mappingCount} name${mappingCount === 1 ? '' : 's'} in the mapping${mappingPreview ? ` (${mappingPreview}${mappingCount > 5 ? '…' : ''})` : ''}\n` +
          `• ${messageCount} message${messageCount === 1 ? '' : 's'} scanned\n` +
          `If you expect names to be redacted, check that they appear LITERALLY in the chat text (the mapping is built from the names the Private AI extracted on Analyze; new messages added since may not be covered — re-run Analyze).`;
      $q.notify({
        type: 'info',
        message: detail,
        timeout: 10000,
        multiLine: true
      });
    }
    return;
  }
  
  // Emit filtered messages to parent component (include mapping for filename filtering)
  emit('messages-filtered', filteredMessages, privacyFilterMapping.value);
  
  const namesList = pseudonymizedNames.map(n => `${n.original} → ${n.pseudonym}`).join(', ');
  
  // Show warning modal after filtering
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Privacy Filter Applied',
      message: 'Privacy filtering can miss sensitive information. Always review the result and use the Edit function to make further changes to the chat before sharing.',
      persistent: false,
      ok: {
        label: 'OK',
        color: 'primary',
        flat: false
      }
    }).onOk(() => {
      // Close Privacy Filter tab and My Stuff dialog
      currentTab.value = 'files'; // Switch to a different tab
      closeDialog(); // Close My Stuff dialog
    });
  }
  
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: `Filtered ${filteredMessageCount} message(s). Replaced: ${namesList || 'names'}`,
      timeout: 3000
    });
  }
};

const loadDiary = async () => {
  loadingDiary.value = true;
  diaryError.value = '';

  const url = `/api/patient-diary?userId=${encodeURIComponent(props.userId)}`;
  try {
    const response = await fetch(url, {
      credentials: 'include'
    });
    if (!response.ok) {
      diaryEntries.value = [];
      loadingDiary.value = false;
      return;
    }
    
    const result = await response.json();
    diaryEntries.value = result.entries || [];
    
    // Assign bubbleIds to entries that don't have them
    // Group entries sequentially, but respect closed bubbles
    let currentBubbleId: string | null = null;
    for (const entry of diaryEntries.value) {
      if (!entry.bubbleId) {
        // Entry doesn't have a bubbleId - assign one
        if (currentBubbleId && !closedBubbleIds.value.has(currentBubbleId)) {
          // Last bubble is open - add to it
          entry.bubbleId = currentBubbleId;
        } else {
          // No bubble or last bubble is closed - create new bubble
          currentBubbleId = `bubble-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          entry.bubbleId = currentBubbleId;
        }
      } else {
        // Entry has a bubbleId - use it as current
        currentBubbleId = entry.bubbleId;
      }
    }
    
    // Load closed bubble IDs from entries that have bubbleId and are posted
    // Mark bubbles as closed if any entry in the bubble is posted
    const bubbleMap = new Map<string, boolean>();
    for (const entry of diaryEntries.value) {
      if (entry.bubbleId) {
        const hasPosted = entry.posted === true;
        if (!bubbleMap.has(entry.bubbleId)) {
          bubbleMap.set(entry.bubbleId, hasPosted);
        } else {
          bubbleMap.set(entry.bubbleId, bubbleMap.get(entry.bubbleId) || hasPosted);
        }
      }
    }
    closedBubbleIds.value = new Set(
      Array.from(bubbleMap.entries())
        .filter(([_, hasPosted]) => hasPosted)
        .map(([bubbleId, _]) => bubbleId)
    );
    
    // Scroll to bottom after loading
    await nextTick();
    if (diaryMessagesRef.value) {
      diaryMessagesRef.value.scrollTop = diaryMessagesRef.value.scrollHeight;
    }
  } catch (err) {
    diaryError.value = err instanceof Error ? err.message : 'Failed to load diary';
  } finally {
    loadingDiary.value = false;
  }
};

const addDiaryEntry = async () => {
  const message = diaryInputText.value.trim();
  if (!message || isSavingDiary.value) {
    return;
  }

  isSavingDiary.value = true;

  try {
    const dateTime = new Date().toISOString();
    
    // Determine which bubble this entry belongs to BEFORE creating it
    // If the last bubble is closed, create a new bubble. Otherwise, add to the last bubble.
    let bubbleId: string;
    if (diaryBubbles.value.length > 0) {
      const lastBubble = diaryBubbles.value[diaryBubbles.value.length - 1];
      if (lastBubble.closed) {
        // Last bubble is closed - create new bubble
        bubbleId = `bubble-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      } else {
        // Last bubble is open - add to it
        bubbleId = lastBubble.id;
      }
    } else {
      // No bubbles yet - create first bubble
      bubbleId = `bubble-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    const entryData = {
      message,
      dateTime,
      bubbleId
    };

    const postUrl = '/api/patient-diary';
    const response = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        entry: entryData
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || 'Failed to save diary entry');
    }

    const result = await response.json();
    
    // Add the new entry to the list with its bubbleId
    const newEntry = {
      id: result.entryId,
      message,
      dateTime,
      bubbleId
    };
    diaryEntries.value.push(newEntry);

    // Clear input
    diaryInputText.value = '';

    // Scroll to bottom to show new entry
    await nextTick();
    if (diaryMessagesRef.value) {
      diaryMessagesRef.value.scrollTop = diaryMessagesRef.value.scrollHeight;
    }

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Diary entry saved',
        timeout: 2000
      });
    }
  } catch (error) {
    console.error('[Diary] Error saving entry:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save diary entry',
        timeout: 3000
      });
    }
  } finally {
    isSavingDiary.value = false;
  }
};

// Track which bubbles have been closed (posted)
const closedBubbleIds = ref<Set<string>>(new Set());

// Group diary entries into bubbles by bubbleId
// Each entry has a bubbleId. Group entries by their bubbleId.
const diaryBubbles = computed(() => {
  if (diaryEntries.value.length === 0) {
    return [];
  }

  // Group entries by bubbleId
  const bubbleMap = new Map<string, Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>>();
  
  for (const entry of diaryEntries.value) {
    const bubbleId = entry.bubbleId || 'no-bubble-id';
    if (!bubbleMap.has(bubbleId)) {
      bubbleMap.set(bubbleId, []);
    }
    bubbleMap.get(bubbleId)!.push(entry);
  }

  // Convert to bubble array, sorted by first entry's dateTime
  const bubbles: Array<{ 
    id: string;
    entries: Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>; 
    lastDateTime: string;
    closed: boolean;
  }> = [];

  for (const [bubbleId, entries] of bubbleMap.entries()) {
    // Sort entries by dateTime
    const sortedEntries = [...entries].sort((a, b) => 
      new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime()
    );
    
    const lastDateTime = sortedEntries[sortedEntries.length - 1]?.dateTime || '';
    const isClosed = closedBubbleIds.value.has(bubbleId);
    
    bubbles.push({
      id: bubbleId,
      entries: sortedEntries,
      lastDateTime,
      closed: isClosed
    });
  }

  // Sort bubbles by first entry's dateTime
  bubbles.sort((a, b) => {
    const dateA = new Date(a.entries[0]?.dateTime || 0);
    const dateB = new Date(b.entries[0]?.dateTime || 0);
    return dateA.getTime() - dateB.getTime();
  });

  return bubbles;
});

const formatDiaryDateTime = (dateTimeString: string): string => {
  const date = new Date(dateTimeString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  // Format: "Today at 3:45 PM" or "Yesterday at 2:30 PM" or "Jan 15, 2025 at 10:30 AM"
  const timeStr = date.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
  
  if (diffMins < 1) {
    return `Just now`;
  } else if (diffMins < 60) {
    return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  } else if (diffDays === 0) {
    return `Today at ${timeStr}`;
  } else if (diffDays === 1) {
    return `Yesterday at ${timeStr}`;
  } else {
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
    return `${dateStr} at ${timeStr}`;
  }
};

const formatDiaryTime = (dateTimeString: string): string => {
  const date = new Date(dateTimeString);
  return date.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
};

const postBubbleToChat = (bubble: { id: string; entries: Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>; lastDateTime: string; closed: boolean }) => {
  // Format the bubble content
  const bubbleContent = bubble.entries
    .map(entry => {
      const time = formatDiaryTime(entry.dateTime);
      return `${time} ${entry.message}`;
    })
    .join('\n');
  
  const diaryMessage = `Here is my latest patient diary:\n\n${bubbleContent}`;
  
  // Emit to parent to add to chat
  emit('diary-posted', diaryMessage);
  
  // Mark this bubble as closed by adding its bubble ID to closedBubbleIds
  // This marks the bubble as closed so the next message starts a new bubble
  closedBubbleIds.value.add(bubble.id);
  
  // Also update local entries (for backend persistence)
  bubble.entries.forEach(entry => {
    const localEntry = diaryEntries.value.find(e => e.id === entry.id);
    if (localEntry) {
      localEntry.posted = true;
    }
  });
  
  // Update backend to mark entries as posted
  updateDiaryEntriesPosted(bubble.entries.map(e => e.id));
  
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Diary posted to chat',
      timeout: 2000
    });
  }
};

const updateDiaryEntriesPosted = async (entryIds: string[]) => {
  try {
    await fetch('/api/patient-diary/mark-posted', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        entryIds
      })
    });
  } catch (error) {
    console.error('[Diary] Error marking entries as posted:', error);
  }
};

// Shared References Functions
const loadReferences = async () => {
  loadingReferences.value = true;
  referencesError.value = '';

  try {
    const response = await fetch(`/api/user-files?userId=${props.userId}&subfolder=References`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch references: ${response.statusText}`);
    }

    const result = await response.json();
    referenceFiles.value = (result.files || []).map((file: any) => ({
      fileName: file.fileName,
      bucketKey: file.bucketKey,
      fileSize: file.fileSize,
      uploadedAt: file.uploadedAt,
      fileType: file.fileType,
      fileUrl: file.fileUrl
    }));
  } catch (err) {
    referencesError.value = err instanceof Error ? err.message : 'Failed to load references';
  } finally {
    loadingReferences.value = false;
  }
};

const triggerReferenceFileInput = () => {
  referenceFileInput.value?.click();
};

const handleReferenceFileSelect = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  
  if (!file) return;

  isUploadingReference.value = true;

  try {
    // Check file size
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 50MB.`);
    }

    // Upload to References subfolder
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('subfolder', 'References');

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
    try {
      const isAppleHealth = String(uploadResult.fileInfo.fileName || '').toLowerCase().endsWith('.pdf')
        ? await detectAppleHealthFromBucket(uploadResult.fileInfo.bucketKey)
        : false;
      await fetch('/api/user-file-metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.userId,
          fileMetadata: {
            fileName: uploadResult.fileInfo.fileName,
            bucketKey: uploadResult.fileInfo.bucketKey,
            bucketPath: uploadResult.fileInfo.userFolder,
            fileSize: uploadResult.fileInfo.size,
            fileType: file.name.endsWith('.pdf') ? 'pdf' : (file.name.endsWith('.md') ? 'markdown' : 'text'),
            uploadedAt: uploadResult.fileInfo.uploadedAt,
            isAppleHealth: isAppleHealth,
            isReference: true // Mark as reference file
          }
        })
      });
    } catch (error) {
      console.warn('Failed to save file metadata to user document:', error);
    }

    // Reload references list
    await loadReferences();

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Reference file uploaded successfully',
        timeout: 2000
      });
    }
  } catch (error) {
    console.error('Error uploading reference file:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to upload reference file',
        timeout: 3000
      });
    }
  } finally {
    isUploadingReference.value = false;
    // Reset input
    if (input) {
      input.value = '';
    }
  }
};

const viewReferenceFile = (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }) => {
  // Use the same PDF viewer modal as other files
  if (file.fileType === 'pdf' && file.bucketKey) {
    viewFileInPdfViewer({
      fileName: file.fileName,
      bucketKey: file.bucketKey,
      fileSize: file.fileSize,
      uploadedAt: file.uploadedAt,
      inKnowledgeBase: false
    });
  } else {
    // For text files, use PDF viewer modal (it can handle text too)
    viewFileInPdfViewer({
      fileName: file.fileName,
      bucketKey: file.bucketKey,
      fileSize: file.fileSize,
      uploadedAt: file.uploadedAt,
      inKnowledgeBase: false
    });
  }
};

const deleteReferenceFile = async (file: { fileName: string; bucketKey: string }) => {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Delete Reference File',
      message: `Are you sure you want to delete "${file.fileName}"?`,
      persistent: true,
      ok: {
        label: 'Delete',
        color: 'negative',
        flat: false
      },
      cancel: {
        label: 'Cancel',
        color: 'grey',
        flat: true
      }
    }).onOk(async () => {
      try {
        const response = await fetch('/api/files/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.userId,
            bucketKey: file.bucketKey
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to delete file');
        }

        // Remove from list
        referenceFiles.value = referenceFiles.value.filter(f => f.bucketKey !== file.bucketKey);

        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'positive',
            message: 'Reference file deleted successfully',
            timeout: 2000
          });
        }
      } catch (error) {
        console.error('Error deleting reference file:', error);
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'negative',
            message: error instanceof Error ? error.message : 'Failed to delete reference file',
            timeout: 3000
          });
        }
      }
    });
  }
};

const showAddReferenceToChatDialog = (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }) => {
  selectedReferenceForChat.value = file;
  
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Add Reference to Chat',
      message: `Would you like to add "${file.fileName}" to the current chat? Reference files are not considered for indexing in the patient's knowledge base.`,
      persistent: true,
      ok: {
        label: 'ADD TO CHAT',
        color: 'primary',
        flat: false
      },
      cancel: {
        label: 'CANCEL',
        color: 'grey',
        flat: true
      }
    }).onOk(() => {
      addReferenceToChat(file);
    }).onCancel(() => {
      selectedReferenceForChat.value = null;
    }).onDismiss(() => {
      selectedReferenceForChat.value = null;
    });
  }
};

const addReferenceToChat = (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }) => {
  // Emit event to add file to chat
  emit('reference-file-added', {
    fileName: file.fileName,
    bucketKey: file.bucketKey,
    fileSize: file.fileSize,
    uploadedAt: file.uploadedAt,
    fileType: file.fileType || 'text',
    fileUrl: file.fileUrl,
    isReference: true
  });
  
  selectedReferenceForChat.value = null;
  
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Reference file added to chat',
      timeout: 2000
    });
  }
};

const deleteBubble = async (bubble: { id: string; entries: Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>; lastDateTime: string; closed: boolean }) => {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Delete Diary Bubble',
      message: `Are you sure you want to delete this diary bubble with ${bubble.entries.length} entr${bubble.entries.length === 1 ? 'y' : 'ies'}?`,
      persistent: true,
      ok: {
        label: 'Delete',
        color: 'negative',
        flat: false
      },
      cancel: {
        label: 'Cancel',
        color: 'grey',
        flat: true
      }
    }).onOk(async () => {
      try {
        const entryIds = bubble.entries.map(e => e.id);
        
        const response = await fetch('/api/patient-diary/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.userId,
            entryIds
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          throw new Error(errorData.error || 'Failed to delete diary entries');
        }

        // Remove entries from local state
        diaryEntries.value = diaryEntries.value.filter(entry => !entryIds.includes(entry.id));
        
        // Also remove from closed bubble set
        if (closedBubbleIds.value.has(bubble.id)) {
          closedBubbleIds.value.delete(bubble.id);
        }

        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'positive',
            message: 'Diary bubble deleted',
            timeout: 2000
          });
        }
      } catch (error) {
        console.error('[Diary] Error deleting bubble:', error);
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'negative',
            message: error instanceof Error ? error.message : 'Failed to delete diary bubble',
            timeout: 3000
          });
        }
      }
    });
  }
};

const loadPatientSummary = async () => {
  loadingSummary.value = true;
  summaryError.value = '';

  // Ensure Private AI profile labels are available for instruction tabs.
  if (agentProfilesList.value.length === 0) {
    try {
      const provResp = await fetch('/api/chat/providers', { credentials: 'include' });
      if (provResp.ok) {
        const pd = await provResp.json();
        const list = Array.isArray(pd.privateAiProfiles) ? pd.privateAiProfiles : [];
        if (list.length > 0) {
          agentProfilesList.value = list.map((p: { key: string; label: string }) => ({ key: p.key, label: p.label }));
        }
      }
    } catch { /* non-fatal */ }
  }

  try {
    const response = await fetch(`/api/patient-summary?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch patient summary: ${response.statusText}`);
    }

    const result = await response.json();
    // Server-side splice guarantees `result.summary` always has
    // the verified Current Medications in place (no AI call, no
    // client-side regen dance). See serverReplaceMedicationsIn
    // Summary in the GET /api/patient-summary handler.
    // Prefer a committed summary. If none is committed yet, fall back to the
    // wizard's hidden draft (userDoc.draftPatientSummary) so updateSummary-
    // WithVerifiedMeds has text to splice the verified meds into.
    const committedSummary = result.summary || '';
    const draftSummary = (result.draft && result.draft.text) ? result.draft.text : '';
    const loadedSummary = committedSummary || draftSummary;
    patientSummary.value = loadedSummary;
    summaryEditText.value = loadedSummary;
    patientSummaries.value = result.summaries || [];
    // When we're showing the draft (no commit yet), require the user to verify
    // it before it appears as the "saved" summary.
    if (!committedSummary && draftSummary) {
      summaryNeedsVerify.value = true;
    }
    if (!loadedSummary) {
      isEditingSummaryTab.value = false;
    }

    // Check medications consistency after loading summary — but only if this
    // is NOT the first-ever summary (initial creation naturally differs from the
    // verified medications list because the AI uses its own wording).
    const summaryCount = (result.summaries || []).length;
    if (loadedSummary && !medsMismatchAcknowledged.value && summaryCount > 1) {
      await checkMedicationsConsistency();
    }
  } catch (err) {
    summaryError.value = err instanceof Error ? err.message : 'Failed to load patient summary';
  } finally {
    loadingSummary.value = false;
  }
};

/* ── Dual-AI Patient Summary chooser ──────────────────────────────────
 * "Request New Summary" runs the prompt against BOTH Private AIs
 * in parallel via /api/patient-summary/generate-pair and lets the user
 * pick one with "Choose this one". Each candidate carries
 * the model name + generation time so the comparison is transparent.
 * Choosing routes through the existing handleReplaceSummary save flow
 * (auto-saves to an empty slot, or shows the Replace dialog when full).
 */
interface SummaryCandidate {
  ok: boolean; profileKey: string; model: string;
  text?: string; error?: string; reason?: string; status?: number;
  generationSeconds?: number;
}
const summaryPair = ref<{ generatedAt: string; default: SummaryCandidate | null; gpt: SummaryCandidate | null } | null>(null);
const loadingPair = ref(false);
const pairError = ref('');

/* ── Patient Summary sub-tabs ─────────────────────────────────────────
 * "Summary" + "Instructions for Deepseek" + "Instructions for GPT".
 * Each instruction tab edits the per-agent Patient Summary prompt
 * (userDoc.agentProfiles[profileKey].patientSummaryPrompt). Empty saves
 * clear the override and revert to the Layer-2 default.
 */
const summarySubTab = ref<'summary' | 'inst-default' | 'inst-gpt'>('summary');
const summaryInstr = ref<{ loading: boolean; saving: boolean; profileKey: string; text: string; defaultText: string; status: string }>({
  loading: false, saving: false, profileKey: 'default', text: '', defaultText: '', status: ''
});

const loadPatientSummaryInstructions = async (profileKey: 'default' | 'gpt') => {
  if (!props.userId) return;
  summaryInstr.value = { loading: true, saving: false, profileKey, text: '', defaultText: '', status: '' };
  try {
    const r = await fetch(`/api/agent-instructions/patient-summary?userId=${encodeURIComponent(props.userId)}&profileKey=${profileKey}`, { credentials: 'include' });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.success) {
      summaryInstr.value = {
        loading: false, saving: false,
        profileKey,
        // Primary: pre-fill with the default template so the user can edit.
        // Secondary: leave blank (no custom instructions by design).
        text: (d.override && d.override.trim()) ? d.override : (profileKey === 'gpt' ? '' : (d.default || '')),
        defaultText: d.default || '',
        status: d.override ? 'Custom override saved' : (profileKey === 'gpt' ? 'No custom instructions' : 'Using default')
      };
    } else {
      summaryInstr.value = { loading: false, saving: false, profileKey, text: '', defaultText: '', status: d.error || 'Failed to load' };
    }
  } catch (err) {
    summaryInstr.value = { loading: false, saving: false, profileKey, text: '', defaultText: '', status: err instanceof Error ? err.message : 'Failed to load' };
  }
};

const savePatientSummaryInstructions = async () => {
  if (!props.userId) return;
  const profileKey = summaryInstr.value.profileKey;
  // If the user left the editor identical to the default, save as a clear
  // (null) so the override doesn't stick around as redundant noise.
  const text = summaryInstr.value.text;
  const isDefault = text.trim() === (summaryInstr.value.defaultText || '').trim();
  summaryInstr.value.saving = true;
  summaryInstr.value.status = 'Saving…';
  try {
    const r = await fetch('/api/agent-instructions/patient-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, profileKey, prompt: isDefault ? '' : text })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.success === false) throw new Error(d.error || `HTTP ${r.status}`);
    summaryInstr.value.status = d.cleared ? 'Reverted to default' : 'Saved';
    if ($q?.notify) $q.notify({ type: 'positive', message: d.cleared ? 'Reverted to default Patient Summary prompt' : 'Patient Summary instructions saved', timeout: 2500 });
  } catch (err) {
    summaryInstr.value.status = err instanceof Error ? err.message : 'Save failed';
    if ($q?.notify) $q.notify({ type: 'negative', message: summaryInstr.value.status, timeout: 5000 });
  } finally {
    summaryInstr.value.saving = false;
  }
};

const resetPatientSummaryInstructions = async () => {
  if (!props.userId) return;
  const profileKey = summaryInstr.value.profileKey;
  summaryInstr.value.saving = true;
  summaryInstr.value.status = 'Clearing override…';
  try {
    const r = await fetch('/api/agent-instructions/patient-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, profileKey, prompt: '' })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.success === false) throw new Error(d.error || `HTTP ${r.status}`);
    // After clearing, reload to pre-fill with the default body again.
    await loadPatientSummaryInstructions(profileKey === 'gpt' ? 'gpt' : 'default');
  } catch (err) {
    summaryInstr.value.status = err instanceof Error ? err.message : 'Reset failed';
  } finally {
    summaryInstr.value.saving = false;
  }
};

// Switch to an instruction tab → fetch its current override.
watch(summarySubTab, (tab) => {
  if (tab === 'inst-default') void loadPatientSummaryInstructions('default');
  else if (tab === 'inst-gpt') void loadPatientSummaryInstructions('gpt');
});


const chooseSummaryCandidate = async (text: string) => {
  if (!text || !text.trim()) return;
  const trimmed = text.trim();
  // Reuse the existing save path: auto-save to an empty slot if available,
  // otherwise prompt the user to pick which existing summary to replace.
  const summaryCount = patientSummaries.value.length;
  if (summaryCount < 3) {
    await handleReplaceSummary('newest', trimmed);
  } else {
    savedCurrentSummaryForUndo.value = patientSummaries.value[patientSummaries.value.length - 1] || null;
    newSummaryToReplace.value = trimmed;
    showReplaceSummaryDialog.value = true;
  }
  // Clear the chooser — the chosen summary now lives in patientSummary.
  summaryPair.value = null;
  pairError.value = '';
};

const dismissSummaryPair = () => {
  summaryPair.value = null;
  pairError.value = '';
};

const handleRequestNewSummary = () => {
  summaryPair.value = null;
  currentTab.value = 'summary';
  pendingSummaryRegeneration.value = true;
  requestNewSummary();
};

const requestNewSummary = async () => {
  if (!props.userId) return;
  try {
    const sessionCheck = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' });
    if (!sessionCheck.ok) {
      await loadPatientSummary();
      return;
    }
  } catch {
    await loadPatientSummary();
    return;
  }

  loadingSummary.value = true;
  generatingSummary.value = true;
  summaryError.value = '';
  startSummaryProgress();

  try {
    const response = await fetch('/api/generate-patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to generate patient summary');
    }

    const result = await response.json();

    // Use server's summary count (from generate response) so we don't rely on stale client state
    const summaryCount = result.summaries?.length ?? patientSummaries.value.length;
    const hasEmptySlots = summaryCount < 3;
    
    if (hasEmptySlots) {
      // Automatically save with 'newest' strategy (just adds to array)
      await handleReplaceSummary('newest', (result.summary || '').trim());
    } else {
      // All slots full - show dialog to choose which summary to replace
      // Sync local summaries from server so Replace buttons render correctly
      if (result.summaries) {
        patientSummaries.value = result.summaries;
      }
      savedCurrentSummaryForUndo.value = result.savedCurrentSummary || null;
      newSummaryToReplace.value = (result.summary || '').trim();
      showReplaceSummaryDialog.value = true;
    }
  } catch (error) {
    console.error('Error generating patient summary:', error);
    summaryError.value = error instanceof Error ? error.message : 'Failed to generate patient summary';
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: summaryError.value,
        timeout: 5000
      });
    }
  } finally {
    stopSummaryProgress();
    loadingSummary.value = false;
  }
};


// One-shot session flag — the "editing PS won't change CM" warning
// fires the first time the user enters PS edit mode in this
// session. After they acknowledge once we don't badger them.
const psCmEditWarningShownThisSession = ref(false);

const startSummaryEdit = () => {
  summaryEditText.value = patientSummary.value || '';
  isEditingSummaryTab.value = true;
  // Surface the "Current Medications section of the summary is a
  // RENDERED COPY, not the source" gotcha. Without this, users
  // who edit the meds inside the PS text will be confused when
  // those edits don't propagate to the My Lists Current
  // Medications worksheet or to subsequently-generated summaries.
  if (!psCmEditWarningShownThisSession.value) {
    psCmEditWarningShownThisSession.value = true;
    if ($q && typeof $q.dialog === 'function') {
      $q.dialog({
        title: 'Heads up',
        message: 'Editing the Patient Summary does not change the Current Medications. If you want to update them, do that first.',
        ok: { label: 'OK', color: 'primary' }
      });
    } else {
      window.alert('Editing the Patient Summary does not change the Current Medications. If you want to update them, do that first.');
    }
  }
};

const cancelSummaryEdit = () => {
  isEditingSummaryTab.value = false;
  summaryEditText.value = '';
};

/**
 * Extract the "Current Medications" section from a Patient Summary text.
 * Looks for headings like "Current Medications", "## Current Medications", "**Current Medications**".
 * Returns the text from that heading to the next heading, or null if not found.
 */
const extractMedicationsFromSummary = (summaryText: string): string | null => {
  const lines = summaryText.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();
    if (
      line.match(/^#{1,3}\s*current\s+medications/) ||
      line.match(/^\*{1,2}current\s+medications\*{1,2}/) ||
      line === 'current medications' ||
      line === 'current medications:'
    ) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.match(/^#{1,3}\s+/) || (line.match(/^\*{2}.+\*{2}$/) && !line.toLowerCase().includes('medication'))) {
      endIdx = i;
      break;
    }
  }
  const medsText = lines.slice(startIdx, endIdx).join('\n').trim();
  return medsText.length > 0 ? medsText : null;
};

/**
 * Normalize medication text for comparison: lowercase, collapse whitespace, strip markdown bullets/formatting.
 */
const normalizeMedsText = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/\*{1,2}/g, '')          // strip bold/italic markers
    .replace(/^[-*•]\s*/gm, '')       // strip bullet prefixes
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim();
};

/**
 * Fetch the verified Current Medications and compare with what's in the Patient Summary.
 * If they differ, show a warning dialog.
 */
const checkMedicationsConsistency = async () => {
  if (!patientSummary.value || !props.userId) return;

  try {
    const res = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (!res.ok) return;
    const status = await res.json();
    const medsFromList = status.currentMedications;
    if (!medsFromList || !String(medsFromList).trim()) return;

    verifiedCurrentMedications.value = medsFromList;

    const medsFromSummary = extractMedicationsFromSummary(patientSummary.value);
    if (!medsFromSummary) return; // summary doesn't have a Current Medications section — nothing to compare

    const normalizedList = normalizeMedsText(medsFromList);
    const normalizedSummary = normalizeMedsText(medsFromSummary);

    if (normalizedList !== normalizedSummary) {
      // The Patient Summary disagrees with the user's Validated Current
      // Medications list. The verified list is always authoritative — auto-
      // patch the summary in place, no modal prompt (the previous
      // "Medications Mismatch" dialog with UPDATE / I UNDERSTAND buttons
      // is gone; an inconsistent summary is unsafe enough that we just fix
      // it). The user still sees a positive toast.
      fetch('/api/wizard-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: props.userId, event: 'Patient Summary auto-updated with verified Current Medications (mismatch detected)', details: {} })
      }).catch(() => {});
      await handleMedsMismatchUpdate();
    }
  } catch (err) {
    console.warn('[MyStuff] Failed to check medications consistency:', err);
  }
};

/**
 * Replace the Current Medications section in a summary with the verified list text.
 * Preserves the heading and everything before/after the section.
 * When `markVerified` is true, deterministically inserts "(Patient Verified)" into
 * the heading (replacing any existing "(patient-confirmed)" / "(patient-verified)"
 * variant the AI may have included).
 */
const replaceMedicationsInSummary = (
  summaryText: string,
  newMedsText: string,
  markVerified: boolean = false
): string | null => {
  const lines = summaryText.split('\n');
  let headingIdx = -1;
  // Permissive: match any line where, after stripping markdown decoration
  // (#, *, _, whitespace), the visible text starts with "current medications".
  // Catches:  ## Current Medications  /  **Current Medications**  /
  //   ## **Current Medications**  /  Current Medications:  /
  //   **Current Medications** (Patient Verified)  /  etc.
  // The previous regex needed `*` or `#` exclusively at line start which
  // missed the heading-plus-bold combo agents commonly produce.
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].toLowerCase().replace(/[#*_`]/g, '').trim();
    if (stripped.startsWith('current medications')) {
      headingIdx = i;
      break;
    }
  }
  // If no heading was found, fall back to appending a fresh one at the end.
  // The user's verified meds must always end up in the summary; returning
  // null here is what caused the "summary has different meds than I saved"
  // regression.
  if (headingIdx < 0) {
    if (!newMedsText || !newMedsText.trim()) return null;
    const appended = `${summaryText.trimEnd()}\n\n## Current Medications${markVerified ? ' (Patient Verified)' : ''}\n\n${newMedsText}\n`;
    return appended;
  }

  // Safety: if the caller handed us empty meds, never blank the section body.
  // Just toggle the verification marker on the heading and keep the original body.
  if (!newMedsText || !newMedsText.trim()) {
    if (!markVerified) return null;
    let hOnly = lines[headingIdx];
    hOnly = hOnly.replace(/\s*\((?:patient[\s-]?(?:verified|confirmed))\)\s*/gi, '').replace(/\s+$/, '');
    hOnly = `${hOnly} (Patient Verified)`;
    const updated = [...lines.slice(0, headingIdx), hOnly, ...lines.slice(headingIdx + 1)].join('\n');
    return updated === summaryText ? null : updated;
  }

  const startIdx = headingIdx + 1;
  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.match(/^#{1,3}\s+/) || (line.match(/^\*{2}.+\*{2}$/) && !line.toLowerCase().includes('medication'))) {
      endIdx = i;
      break;
    }
  }

  // Normalize the heading: strip any existing verification marker the AI may have
  // added ("(patient-confirmed)", "(patient verified)", etc.), then optionally
  // append a deterministic "(Patient Verified)" tag.
  let heading = lines[headingIdx];
  heading = heading.replace(/\s*\((?:patient[\s-]?(?:verified|confirmed))\)\s*/gi, '').replace(/\s+$/, '');
  if (markVerified) {
    heading = `${heading} (Patient Verified)`;
  }

  const before = lines.slice(0, headingIdx);
  const after = lines.slice(endIdx);
  return [...before, heading, '', newMedsText, '', ...after].join('\n').trim();
};

/**
 * Handle UPDATE from the mismatch dialog: splice the verified Current Medications
 * into the existing Patient Summary (no full regeneration).
 */
const handleMedsMismatchUpdate = async () => {
  showMedsMismatchDialog.value = false;
  medsMismatchAcknowledged.value = true;
  fetch('/api/wizard-log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ userId: props.userId, event: 'Dialog: Medications Mismatch — user chose UPDATE', details: {} })
  }).catch(() => {});

  const meds = verifiedCurrentMedications.value;
  if (!meds || !patientSummary.value) return;

  const updated = replaceMedicationsInSummary(patientSummary.value, meds);
  if (!updated) {
    // Couldn't find the section — fall back to full regeneration
    await requestNewSummary();
    return;
  }

  // Save the patched summary in place (replaces the current slot)
  loadingSummary.value = true;
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: updated,
        replaceStrategy: 'newest'
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to save updated summary');
    }
    await loadPatientSummary();
    emit('patient-summary-saved', { userId: props.userId, summary: patientSummary.value || '' });
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient Summary updated with verified Current Medications.',
        timeout: 3000
      });
    }
  } catch (error) {
    console.error('Error patching summary medications:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to update summary',
        timeout: 5000
      });
    }
  } finally {
    loadingSummary.value = false;
  }
};

/**
 * Update the pre-generated Patient Summary with the verified Current Medications.
 * Called from the wizard when a summary was generated in the background and the user
 * has since verified/edited their medications.
 */
const updateSummaryWithVerifiedMeds = async () => {
  // Set verify flag immediately — prevents flash of "verified" state before prompt appears
  summaryNeedsVerify.value = true;
  try {
    // Prefer the meds text passed from the emit chain — it's the exact value
    // Lists.vue just POSTed, and avoids a race against the user-status GET.
    let meds = (pendingVerifiedMedsText.value || '').trim();
    // Consume the pending value so a subsequent call doesn't reuse it.
    pendingVerifiedMedsText.value = null;
    if (!meds) {
      // Fallback: fetch from the server (used when Verify-without-edit bypasses
      // saveCurrentMedicationsValue, or when the pending value is missing).
      try {
        const res = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
          credentials: 'include'
        });
        const status = res.ok ? await res.json() : {};
        meds = String(status.currentMedications || '').trim();
      } catch {
        meds = '';
      }
    }

    // Reload the latest summary (the provisional generated after KB indexing)
    await loadPatientSummary();

    // No provisional summary to patch — nothing to do. The user will see whatever
    // exists (or the empty state) and can act accordingly. We never make a second
    // AI call for summary generation — the wizard budget is exactly 2 AI calls.
    if (!patientSummary.value) {
      console.warn('[MyStuff] No provisional Patient Summary available to patch');
      try {
        await fetch('/api/provisioning-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: props.userId, event: 'no-draft-ps-available', source: 'MyStuffDialog' })
        });
      } catch { /* non-fatal */ }
      loadingSummary.value = false;
      return;
    }

    // If there are no verified meds, still mark the heading as patient-verified
    // (the user actively went through the medications step, even if they dismissed).
    const updated = replaceMedicationsInSummary(patientSummary.value, meds || '', true);
    if (!updated) {
      // Couldn't find the Current Medications section in the provisional.
      // Leave the provisional as-is rather than regenerate via AI.
      console.warn('[MyStuff] Could not locate Current Medications section in provisional summary');
      loadingSummary.value = false;
      return;
    }

    // Skip save if nothing actually changed (common on Verify-without-edit)
    if (updated === patientSummary.value) {
      loadingSummary.value = false;
      return;
    }

    // Save the patched summary
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: updated,
        replaceStrategy: 'newest'
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to save updated summary');
    }
    summaryNeedsVerify.value = true; // Set before load so UI doesn't flash without verify prompt
    await loadPatientSummary();
    emit('patient-summary-saved', { userId: props.userId, summary: updated });
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient Summary updated with verified Current Medications.',
        timeout: 3000
      });
    }
  } catch (error) {
    console.error('Error updating summary with verified medications:', error);
    // Do NOT fall back to regenerating — budget is 2 AI calls, no more.
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to update summary',
        timeout: 5000
      });
    }
  } finally {
    loadingSummary.value = false;
  }
};

// (handleMedsMismatchAcknowledge removed with the Medications Mismatch
// dialog — when verified meds differ from the Patient Summary we now
// auto-patch in checkMedicationsConsistency, no user prompt.)

const saveSummaryFromTab = async () => {
  if (!props.userId) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'User ID is required to save the summary'
      });
    }
    return;
  }

  const summaryToSave = summaryEditText.value.trim();
  if (!summaryToSave) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'Summary cannot be empty'
      });
    }
    return;
  }

  isSavingSummary.value = true;

  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(errorData.message || 'Failed to save patient summary');
    }

    patientSummary.value = summaryToSave;
    newPatientSummary.value = summaryToSave;
    summaryViewText.value = summaryToSave;
    summaryEditText.value = summaryToSave;
    isEditingSummaryTab.value = false;
    emit('patient-summary-saved', { userId: props.userId, summary: patientSummary.value || '' });

    // Extract Current Medications from Patient Summary and save — but only if
    // the user hasn't already verified medications (their verified list is authoritative).
    try {
      const statusRes = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
        credentials: 'include'
      });
      const hasVerifiedMeds = statusRes.ok && (await statusRes.json()).currentMedications;
      if (!hasVerifiedMeds) {
        const medsText = extractMedicationsFromSummary(summaryToSave);
        if (medsText) {
          await fetch('/api/user-current-medications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              userId: props.userId,
              currentMedications: medsText
            })
          });
          emit('current-medications-saved', { value: medsText, edited: false });
        }
      }
    } catch (medsError) {
      console.warn('Failed to auto-save medications from summary:', medsError);
    }

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    console.error('Error saving summary:', error);
    const message = error instanceof Error ? error.message : 'Failed to save patient summary';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message
      });
    }
  } finally {
    isSavingSummary.value = false;
  }
};

const extractMedsFromPS = (psText: string): string[] => {
  const lines = psText.split('\n');
  let inMedsSection = false;
  const meds: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,3}\s*\**\s*Current\s+Medications/i.test(trimmed) || /^\*\*Current\s+Medications\*\*/i.test(trimmed)) {
      inMedsSection = true;
      continue;
    }
    if (inMedsSection) {
      if (/^#{1,3}\s/.test(trimmed) || /^\*\*[A-Z]/.test(trimmed)) break;
      const medLine = trimmed.replace(/^[-*•]\s*/, '').trim();
      if (medLine && !/^not documented/i.test(medLine) && !/^no current/i.test(medLine) && !/^none/i.test(medLine)) {
        meds.push(medLine);
      }
    }
  }
  return meds;
};

const handleVerifySummaryTab = async () => {
  if (!props.userId || !patientSummary.value) return;

  // Compare the PS's Current Medications against the SERVER's verified list
  // (userDoc.currentMedications — the source of truth). We do NOT read the
  // Lists component ref: the Lists tab panel is UNMOUNTED while the Summary
  // tab is active (q-tab-panels has no keep-alive), so that ref is null here
  // and produced a phantom "meds differ" every time. During the wizard the
  // PS was just patched from the verified list, so they match by construction
  // → no modal. Only a genuine manual PS edit trips the warning.
  const psMeds = extractMedsFromPS(patientSummary.value);
  let verifiedMeds = '';
  try {
    const res = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' });
    if (res.ok) {
      const status = await res.json();
      verifiedMeds = String(status.currentMedications || '').trim();
    }
  } catch { /* treat as no verified list */ }

  const verifiedLines = verifiedMeds.split('\n').map(l => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
  const verifiedIsNone = !verifiedMeds || verifiedMeds.toLowerCase() === 'none' || verifiedLines.length === 0;

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const psSorted = [...psMeds].map(norm).sort().join('|');
  const verifiedSorted = [...verifiedLines].map(norm).sort().join('|');
  const medsMatch = psSorted === verifiedSorted;

  // Warn only if the PS's Current Medications genuinely differ from the verified list.
  if (!medsMatch && (psMeds.length > 0 || !verifiedIsNone)) {
    if ($q && typeof $q.dialog === 'function') {
      $q.dialog({
        title: 'Custom Medications in Patient Summary',
        message: 'The Current Medications in your Patient Summary differ from your verified medication list. ' +
          'This is allowed — the next time a Patient Summary is generated, it will use your verified list again.',
        ok: { label: 'Keep custom & verify', color: 'primary' },
        cancel: { label: 'Cancel', flat: true },
        persistent: false
      }).onOk(() => {
        finishVerifySummary();
      });
      return;
    }
  }

  finishVerifySummary();
};

const finishVerifySummary = () => {
  summaryNeedsVerify.value = false;
  emit('patient-summary-verified', { userId: props.userId! });
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Patient summary verified.'
    });
  }
};

const sortedSharedChats = computed(() => {
  return [...sharedChats.value].sort((a, b) => {
    const dateA = new Date(a.updatedAt || a.createdAt);
    const dateB = new Date(b.updatedAt || b.createdAt);
    return dateB.getTime() - dateA.getTime();
  });
});

const closeDialog = async (): Promise<boolean> => {
  // Track if user dismissed the summary tab without verifying
  if (currentTab.value === 'summary' && summaryNeedsVerify.value) {
    summaryDismissedThisSession.value = true;
  }

  // NOTE: We deliberately do NOT block closing on `indexingKB &&
  // currentIndexingJobId` here. KB indexing is a server-side job —
  // it continues to completion whether or not the dialog stays
  // open. The previous "Indexing in progress" modal interrupted
  // users on every X-out (including spurious re-index jobs queued
  // by handleRehydrationComplete after a successful Restore),
  // offered "Cancel" with no explanation of what cancel would
  // undo, and trapped users in a loop because closing kills the
  // polling UI but the modal kept firing. The polling tear-down
  // in pollIndexingProgress (`if (!isOpen.value) clearInterval`)
  // is the correct behavior; the modelValue watcher re-attaches
  // polling when the dialog reopens. If you actually want to
  // CANCEL an in-flight job, do it from the Files tab's per-file
  // "Cancel indexing" affordance (cancelIndexingAndRestore) where
  // the consequences are explicit.

  if (hasUnsavedChanges.value) {
    const confirmClose = await new Promise<boolean>((resolve) => {
      if ($q && typeof $q.dialog === 'function') {
        $q.dialog({
          title: 'Unsaved changes',
          message: 'You have unsaved changes in My Agent or Patient Summary. Close without saving?',
          cancel: true,
          persistent: true,
          ok: {
            label: 'Discard and Close',
            color: 'negative'
          }
        }).onOk(() => resolve(true))
          .onCancel(() => resolve(false))
          .onDismiss(() => resolve(false));
      } else {
        const shouldClose = window.confirm('You have unsaved changes in My Agent or Patient Summary. Close without saving?');
        resolve(shouldClose);
      }
    });

    if (!confirmClose) {
      return false;
    }

    if (hasUnsavedAgentChanges.value) {
      cancelEdit();
    }

    if (hasUnsavedSummaryChanges.value) {
      cancelSummaryEdit();
    }
  }

  isOpen.value = false;
  return true;
};

watch(() => props.modelValue, async (newValue) => {
  isOpen.value = newValue;
  if (newValue) {
    // Reset per-open state
    medsMismatchAcknowledged.value = false;

    // Refresh the Groups rail-icon alert on every open so the blue
    // triangle reflects current invites/requests/messages.
    refreshGroupsAlert();

    // Eagerly load files so processFileNCitations can resolve citations
    // on any tab (Patient Summary, Lists) without waiting for the files tab.
    if (userFiles.value.length === 0) {
      loadFiles();
    }

    // Honor a newly-supplied initialTab from the parent (a
    // programmatic open like "open at Patient Summary after a
    // fresh generation"). Don't re-apply the SAME initialTab
    // every reopen — that would clobber the user's last choice
    // when they re-expand via the rail. See the
    // `lastAppliedInitialTab` doc comment near currentTab init.
    if (props.initialTab && props.initialTab !== lastAppliedInitialTab) {
      currentTab.value = props.initialTab;
      lastAppliedInitialTab = props.initialTab;
    }
    
    // Check for active indexing job and restore polling if needed
    try {
      const statusResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(props.userId)}`, {
        credentials: 'include'
      });
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        const jobId = statusData.kbIndexingJobId || statusData.kbLatestJobId || null;
        if (statusData.kbIndexingActive && jobId && !currentIndexingJobId.value) {
          try {
            const jobStatusResponse = await fetch(`/api/kb-indexing-status/${jobId}?userId=${encodeURIComponent(props.userId)}`, {
              credentials: 'include'
            });
            if (jobStatusResponse.ok) {
              const jobStatusData = await jobStatusResponse.json();
              if (jobStatusData.phase && jobStatusData.phase !== 'complete' && jobStatusData.phase !== 'error') {
                currentIndexingJobId.value = jobId;
                indexingKB.value = true;
                indexingStatus.value = {
                  phase: jobStatusData.phase || 'indexing',
                  message: jobStatusData.message || 'Indexing in progress...',
                  kb: jobStatusData.kb || statusData.kbId || '',
                  tokens: jobStatusData.tokens || '0',
                  filesIndexed: jobStatusData.filesIndexed || 0,
                  progress: jobStatusData.progress || 0,
                  error: jobStatusData.error || ''
                };
                pollIndexingProgress(jobId);
              }
            }
          } catch (jobStatusError) {
            console.warn('Failed to check job status on dialog open:', jobStatusError);
          }
        }
      }
    } catch (statusError) {
      console.warn('Failed to check indexing status on dialog open:', statusError);
    }
    
    // Load data when dialog opens
    if (currentTab.value === 'files') {
      loadFiles();
    } else if (currentTab.value === 'agent') {
      loadAgent();
    } else if (currentTab.value === 'chats') {
      loadSharedChats();
    } else if (currentTab.value === 'privacy') {
      loadPrivacyFilter();
    } else if (currentTab.value === 'diary') {
      loadDiary();
    } else if (currentTab.value === 'references') {
      loadReferences();
    } else if (currentTab.value === 'lists') {
      // Wizard may have set sessionStorage flags after Lists component was already mounted;
      // re-trigger wizard auto-flow detection so it picks up the new flags.
      nextTick(() => {
        if (listsComponentRef.value) {
          listsComponentRef.value.loadWizardAutoFlow();
          listsComponentRef.value.attemptAutoProcessInitialFile();
        }
      });
    }

  }
});

watch(() => props.initialTab, (newTab) => {
  if (newTab && isOpen.value) {
    // Always show loading spinner when programmatically switching to summary tab.
    // This prevents a flash of stale/old summary content in the render gap between
    // the initialTab watcher and the currentTab watcher (which calls loadPatientSummary).
    if (newTab === 'summary') {
      loadingSummary.value = true;
    }
    currentTab.value = newTab;
  }
});

/** Exposed method: wizard controller calls this to trigger summary generation/update.
 *  Replaces the old requestAction prop — called directly via template ref. */
// Holds meds text passed in from ChatInterface so updateSummaryWithVerifiedMeds
// uses the authoritative value from the current-medications-saved emit instead
// of re-fetching (which races against the POST that just completed).
const pendingVerifiedMedsText = ref<string | null>(null);
const wizardGenerateSummary = (action: 'generate-summary' | 'update-summary-meds', medsText?: string) => {
  if (!isOpen.value) return;
  loadingSummary.value = true;
  pendingSummaryRegeneration.value = true;
  currentTab.value = 'summary';
  if (action === 'update-summary-meds') {
    // Capture the authoritative meds text from the emit so updateSummaryWithVerifiedMeds
    // doesn't have to re-fetch and race the just-completed POST.
    pendingVerifiedMedsText.value = typeof medsText === 'string' ? medsText : null;
    updateSummaryWithVerifiedMeds();
  } else {
    requestNewSummary();
  }
};

defineExpose({ wizardGenerateSummary });

watch(isOpen, (newValue) => {
  emit('update:modelValue', newValue);
  if (!newValue) {
    if (pollingInterval.value) {
      clearInterval(pollingInterval.value);
      pollingInterval.value = null;
    }
    if (elapsedTimeInterval.value) {
      clearInterval(elapsedTimeInterval.value);
      elapsedTimeInterval.value = null;
    }
  }
});

const listsComponentRef = ref<InstanceType<typeof Lists> | null>(null);

const rebuildListsAfterIndexing = async () => {
  try {
    // Find the Apple Health file from the current file list
    const ahFile = userFiles.value.find(f => (f as any).isAppleHealth && f.bucketKey);
    if (ahFile) {
      // Rebuild Apple Health category sidecars (Lists/*.md in Spaces)
      await fetch('/api/files/lists/process-initial-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          bucketKey: ahFile.bucketKey,
          fileName: ahFile.fileName,
          force: true
        })
      });
    }
    // Regenerate Encounters and OOR Labs worksheets
    await Promise.allSettled([
      fetch('/api/encounters/worksheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      }),
      fetch('/api/labs/oor-worksheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      })
    ]);
    // Tell the Lists component to reload all its data
    if (listsComponentRef.value) {
      listsComponentRef.value.reloadAll();
    }
  } catch (e) {
    console.warn('[MyStuff] Post-indexing Lists rebuild failed (non-fatal):', e);
  }
};

watch(currentTab, async (newTab) => {
  if (isOpen.value) {
    emit('tab-opened', newTab);
  }
  if (newTab === 'privacy') {
    if (privacyFilterMapping.value.length > 0) {
      const current = privacyFilterMapping.value;
      const getCanonical = (orig: string) =>
        toCanonical(orig, buildLastNameToFullNameFromFullNames(current.map(m => m.original)));
      const { deduplicated, removed } = deduplicateMapping(current, getCanonical);
      const cleaned = dropOrphanFirstNames(deduplicated);
      if (removed.length > 0 || cleaned.length !== current.length) {
        privacyFilterMapping.value = cleaned;
        try {
          await fetch('/api/privacy-filter-mapping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ mapping: cleaned })
          });
        } catch (saveErr) {
          // Silently handle save errors
        }
      }
    }

    loadPrivacyFilter();
  } else if (isOpen.value) {
    if (newTab === 'files') {
      loadFiles();
    } else if (newTab === 'agent') {
      loadAgent();
    } else if (newTab === 'chats') {
      loadSharedChats();
    } else if (newTab === 'summary') {
      // Skip load if regeneration is already in progress (e.g. after meds edit)
      if (pendingSummaryRegeneration.value) {
        pendingSummaryRegeneration.value = false;
      } else {
        loadPatientSummary();
      }
    } else if (newTab === 'lists') {
      if (listsComponentRef.value) {
        // Re-check for new Apple Health files (may have been added since last visit)
        await listsComponentRef.value.checkInitialFile();
        listsComponentRef.value.reloadCategories();
        listsComponentRef.value.loadWizardAutoFlow();
        listsComponentRef.value.attemptAutoProcessInitialFile();
      }
    } else if (newTab === 'diary') {
      loadDiary();
    } else if (newTab === 'references') {
      loadReferences();
    }
  }
});

// Clean up polling interval on component unmount
onUnmounted(() => {
  if (pollingInterval.value) {
    clearInterval(pollingInterval.value);
    pollingInterval.value = null;
  }
  if (elapsedTimeInterval.value) {
    clearInterval(elapsedTimeInterval.value);
    elapsedTimeInterval.value = null;
  }
  stopKb2Poll();
});
</script>

<style scoped lang="scss">
.q-item {
  cursor: default;
}

.verify-highlight {
  box-shadow: 0 0 0 2px #e53935;
  border-radius: 6px;
}
</style>

<!-- Sidebar shell styles. NOT scoped because the markup is wrapped in
     <Teleport to="body"> — Vue 3's scoped-attribute machinery DOES
     propagate to teleported content in most cases, but the backdrop
     is rendered conditionally and we want to keep the selectors
     resilient to that. Class names are deliberately prefixed with
     `my-stuff-` to avoid global collisions. -->
<style lang="scss">
$my-stuff-rail-width-icons:   60px;
$my-stuff-rail-width-labeled: 180px;
$my-stuff-z: 6000; // above q-dialog default; sub-dialogs from within
                  // (PDF viewer, etc.) still layer above naturally.

.my-stuff-sidebar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  background: #fff;
  border-right: 1px solid #e0e0e0;
  box-shadow: 2px 0 8px rgba(0, 0, 0, 0.06);
  display: flex;
  flex-direction: row;
  z-index: $my-stuff-z;
  overflow: hidden;
  transition: width 220ms ease, right 220ms ease;

  // State 1: rail labeled, content closed.
  &.my-stuff-sidebar--rail-labeled:not(.my-stuff-sidebar--content-open) {
    width: $my-stuff-rail-width-labeled;
  }

  // State 2: rail icons-only, content closed.
  &.my-stuff-sidebar--rail-icons:not(.my-stuff-sidebar--content-open) {
    width: $my-stuff-rail-width-icons;
  }

  // State 3: content open — sidebar expands to the entire viewport
  // (rail + full-width content panel). No backdrop, no chat
  // visible alongside (per UX requirement: "There is never a
  // situation where the MyStuff interface is running and the chat
  // is visible too").
  &.my-stuff-sidebar--content-open {
    width: 100vw;
    box-shadow: 4px 0 16px rgba(0, 0, 0, 0.12);
  }
}

.my-stuff-rail {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 8px 6px;
  gap: 4px;
  background: #fafafa;
  border-right: 1px solid #e8e8e8;
  transition: width 220ms ease;

  // Width follows the parent state — icons-only vs labeled.
  .my-stuff-sidebar--rail-labeled & { width: $my-stuff-rail-width-labeled; }
  .my-stuff-sidebar--rail-icons &   { width: $my-stuff-rail-width-icons; }
}

// Top of rail: "Workbook" label + chevron toggle. Labeled mode
// shows both; icons-only mode shows just the chevron, centered.
.my-stuff-rail__brand {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 8px 8px;
  border-bottom: 1px solid #eee;
  margin-bottom: 6px;

  .my-stuff-sidebar--rail-icons & {
    justify-content: center;
    padding: 4px 0 8px 0;
  }
}

.my-stuff-rail__brand-label {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
  color: #222;
  letter-spacing: 0.2px;
}

.my-stuff-rail__toggle {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: #777;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;

  &:hover { background: rgba(0, 0, 0, 0.06); color: #222; }
  &:focus-visible { outline: 2px solid #1976d2; outline-offset: 2px; }

  &.close-prompt-highlight {
    background: #4caf50;
    color: #fff;
    animation: close-prompt-pulse 1.5s ease-in-out infinite;
    &:hover { background: #388e3c; color: #fff; }
  }
}

@keyframes close-prompt-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.5); }
  50% { box-shadow: 0 0 0 6px rgba(76, 175, 80, 0); }
}

.close-prompt-banner {
  margin: 4px 10px 8px;
  padding: 6px 10px;
  background: #e8f5e9;
  color: #2e7d32;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  text-align: center;
  line-height: 1.3;
}

.my-stuff-rail__btn {
  position: relative;
  height: 44px;
  border-radius: 8px;
  border: 2px solid transparent;     // reserved for the yellow outline
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  padding: 0 10px;
  gap: 10px;
  color: #555;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  text-align: left;

  &:hover { background: rgba(0, 0, 0, 0.06); color: #222; }
  &:focus-visible { outline: 2px solid #1976d2; outline-offset: 2px; }
  &.is-active {
    background: rgba(25, 118, 210, 0.12);
    color: #1976d2;
    font-weight: 500;
  }
  // Attention outline — yellow border around the entire rail
  // button. Different from the rotating ring on Setup Wizard
  // (that one means "wizard in progress"); this one is static
  // and means "this section needs your verification."
  &.has-attention {
    border-color: #fbc02d;
    background: rgba(251, 192, 45, 0.08);
  }

  .my-stuff-sidebar--rail-icons & {
    justify-content: center;
    padding: 0;
  }
}

.my-stuff-rail__icon {
  flex-shrink: 0;
}

.my-stuff-rail__label {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  line-height: 1.2;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;

  // Hide label when rail is in icons-only mode.
  .my-stuff-sidebar--rail-icons & { display: none; }
}

.my-stuff-rail__badge {
  transform: translate(20%, -20%);
}

// Blue "something is waiting" triangle, floated on the top-right of a
// rail icon (currently Groups: invitation / request / new message).
// A small upward triangle drawn with borders; blue to distinguish it
// from the orange verification outline.
.my-stuff-rail__info-triangle {
  position: absolute;
  top: 5px;
  right: 7px;
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-bottom: 9px solid #1976d2;
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.35));
  pointer-events: none;
}

// Setup Wizard rail button: lives at the top of the rail's section
// list (just below the Workbook brand row). When `wizardActive` is
// true, a yellow rotating ring is rendered around the icon as a
// "wizard is running" indicator.
.my-stuff-rail__btn--wizard {
  // Separator under the wizard so it's visually distinct from
  // the 8 section icons below.
  border-bottom: 1px solid #eee;
  border-radius: 8px 8px 0 0;
  margin-bottom: 4px;
  padding-bottom: 4px;
  padding-top: 4px;
}

.my-stuff-rail__wizard-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}

.my-stuff-rail__wizard-ring {
  position: absolute;
  inset: -3px; // ring sits just outside the icon
  border-radius: 50%;
  border: 2px solid #fbc02d;       // yellow
  border-top-color: transparent;   // gap → arrow-chasing-tail look
  animation: my-stuff-wizard-spin 1.1s linear infinite;
  pointer-events: none;
}

@keyframes my-stuff-wizard-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

// User + sign-out group, anchored to the bottom of the rail with
// `margin-top: auto` (the parent <nav> is flex column).
.my-stuff-rail__user {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid #eee;
  display: flex;
  flex-direction: column;
  gap: 6px;

  .my-stuff-sidebar--rail-icons & {
    align-items: center;
  }
}

.my-stuff-rail__user-id {
  font-size: 12px;
  color: #666;
  padding: 0 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.my-stuff-rail__signout {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 10px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: transparent;
  color: #555;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.4px;
  margin: 0 6px 8px 6px;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;

  &:hover {
    background: rgba(229, 57, 53, 0.06);
    color: #e53935;
    border-color: #e53935;
  }
  &:focus-visible { outline: 2px solid #1976d2; outline-offset: 2px; }

  &--icon {
    // Icons-only rail: square button, no label, no border.
    width: 36px;
    padding: 0;
    justify-content: center;
    border: none;
    margin: 0 0 8px 0;
  }
}

.my-stuff-rail__signout-label {
  flex: 1;
}

.my-stuff-content {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: #fff;
}
</style>
