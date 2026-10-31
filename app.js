import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
const AUTH_REDIRECT_URL=window.location.origin+'/';
const supabase=createClient(SUPABASE_URL,SUPABASE_ANON_KEY);
const dashboard=document.getElementById('studentDashboard');
const voterDashboard=document.getElementById('voterDashboard');
const roleChooser=document.getElementById('roleChooser');
let activeUser=null, competitionSettings=null, currentArenaRole=null;
let adminClockInterval=null, adminCountsInterval=null, adminVotingDeadlineMs=null, adminVotingActive=false;
const adminDashboard=document.getElementById('adminDashboard');let isArenaAdmin=false;



supabase.auth.onAuthStateChange((_event,session)=>{
 const nav=document.querySelector('.navactions');
 nav.querySelectorAll('.user-chip').forEach(n=>n.remove());
 nav.querySelectorAll('[data-signout]').forEach(n=>n.remove());
 if(session){
  nav.querySelectorAll('#headerChooseRole').forEach(b=>b.hidden=true);
  const chip=document.createElement('span');chip.className='user-chip';chip.textContent=session.user.email;nav.prepend(chip);
  const signout=document.createElement('button');signout.className='btn';signout.dataset.signout='true';signout.textContent='Sign out';
  signout.addEventListener('click',async()=>{await supabase.auth.signOut()});nav.append(signout);
  setTimeout(async()=>{
   try{
    await checkArenaAdmin();
    if(isArenaAdmin){document.body.classList.add('authenticated-view');dashboard.classList.remove('visible');voterDashboard.classList.remove('visible');adminDashboard.classList.add('visible');adminDashboard.scrollIntoView({behavior:'auto'});return}
    const selectedRole=sessionStorage.getItem('arena_selected_role');
    let {data:role,error}=await supabase.rpc('get_arena_role');if(error)throw error;
    if(!role&&selectedRole){const assigned=await supabase.rpc('set_arena_role',{requested_role:selectedRole});if(assigned.error)throw assigned.error;role=assigned.data}
    if(!role&&!selectedRole){await supabase.auth.signOut();document.body.classList.remove('authenticated-view');roleChooser.scrollIntoView({behavior:'smooth'});return}
    if(!role){document.body.classList.remove('authenticated-view');roleChooser.scrollIntoView({behavior:'smooth'});return}
    if(selectedRole&&selectedRole!==role){await supabase.auth.signOut();throw new Error('This account is registered as '+role+'. Please choose the matching role.')}
    sessionStorage.removeItem('arena_selected_role');currentArenaRole=role;document.body.classList.add('authenticated-view');
    if(role==='team'){voterDashboard.classList.remove('visible');await loadDashboard(session.user);dashboard.scrollIntoView({behavior:'auto'})}
    else if(role==='voter'){dashboard.classList.remove('visible');await loadVoterDashboard(session.user);voterDashboard.scrollIntoView({behavior:'auto'})}
   }catch(err){console.error('Arena role routing failed',err);const msg=document.getElementById('voterMessage');if(msg)msg.textContent=err.message||'Could not open your account dashboard.';document.body.classList.remove('authenticated-view');const toastEl=document.querySelector('.toast');if(toastEl){toastEl.textContent=err.message||'Could not open your dashboard.';toastEl.classList.add('show');setTimeout(()=>toastEl.classList.remove('show'),3500)}}
  },0);
 }else{
  nav.querySelectorAll('.user-chip').forEach(n=>n.remove());nav.querySelectorAll('[data-signout]').forEach(n=>n.remove());
  const choose=nav.querySelector('#headerChooseRole');if(choose)choose.hidden=false;
  document.body.classList.remove('authenticated-view');dashboard.classList.remove('visible');voterDashboard.classList.remove('visible');adminDashboard.classList.remove('visible');isArenaAdmin=false;activeUser=null;currentArenaRole=null;
 }
});


function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
function dashMessage(id,text,isError){const el=document.getElementById(id);if(el){el.textContent=text||'';el.style.color=isError?'#a33':'var(--green)'}}
function submissionWindowOpen(){if(!competitionSettings||!competitionSettings.submissions_open)return false;return !competitionSettings.submission_deadline||new Date(competitionSettings.submission_deadline).getTime()>=Date.now()}
function formatDeadline(value){if(!value)return 'No deadline set';return new Date(value).toLocaleString()}
function getYoutubeEmbedUrl(raw){try{const u=new URL(raw);const host=u.hostname.toLowerCase().replace(/^www\./,'');if(!['youtube.com','m.youtube.com','youtu.be'].includes(host))return null;let id='';if(host==='youtu.be')id=u.pathname.split('/').filter(Boolean)[0]||'';else if(u.pathname==='/watch')id=u.searchParams.get('v')||'';else{const parts=u.pathname.split('/').filter(Boolean);if(['embed','shorts','live','v'].includes(parts[0]))id=parts[1]||''}return /^[A-Za-z0-9_-]{11}$/.test(id)?'https://www.youtube-nocookie.com/embed/'+id:null}catch{return null}}
function addMemberRow(name,roll){const row=document.createElement('div');row.className='member-row';row.innerHTML='<input name="memberName" required maxlength="100" placeholder="Member full name"><input name="rollNumber" required maxlength="40" placeholder="Roll number"><button class="member-remove" type="button">Remove</button>';row.querySelectorAll('input')[0].value=name||'';row.querySelectorAll('input')[1].value=roll||'';row.querySelector('button').addEventListener('click',()=>row.remove());document.getElementById('memberRows').append(row)}
document.getElementById('addMember').addEventListener('click',()=>addMemberRow());
async function renderGroupCard(group){
 const [memberResult,submissionResult]=await Promise.all([
  supabase.from('group_members').select('member_name,roll_number').eq('group_id',group.id).order('created_at'),
  supabase.from('project_submissions').select('id,title,description,video_url,video_path,status,admin_feedback,updated_at').eq('group_id',group.id).maybeSingle()
 ]);
 if(memberResult.error)throw memberResult.error;
 if(submissionResult.error)throw submissionResult.error;
 const members=memberResult.data||[], sub=submissionResult.data;
 const editable=!!(sub&&(sub.status==='draft'||(sub.status==='pending'&&submissionWindowOpen())));
 const canSubmit=!sub||editable;
 const status=sub?'<span class="dash-status '+escapeHtml(sub.status)+'">'+escapeHtml(sub.status)+'</span>':'<span class="dash-status">Not submitted</span>';
 let roster=members.map(m=>'<li><span>'+escapeHtml(m.member_name)+'</span><span>'+escapeHtml(m.roll_number)+'</span></li>').join('');
 let feedback=sub&&sub.admin_feedback?'<div class="deadline-note"><strong>Teacher feedback:</strong> '+escapeHtml(sub.admin_feedback)+'</div>':'';
 let formHtml='';
 if(canSubmit){
  const draftMode=!submissionWindowOpen();
  formHtml='<form class="submission-form" data-group="'+escapeHtml(group.id)+'" data-submission="'+escapeHtml(sub?sub.id:'')+'"><h3>'+(sub?'Project details':'Add your project')+'</h3><label class="dash-field">Project title<input name="title" maxlength="140" required value="'+escapeHtml(sub?sub.title:'')+'" placeholder="Give your project a clear title"></label><label class="dash-field">Project description<textarea name="description" maxlength="5000" required placeholder="Explain the problem, your solution and how it works">'+escapeHtml(sub?sub.description:'')+'</textarea></label><label class="dash-field">YouTube video link<input name="videoUrl" type="url" required value="'+escapeHtml(sub&&sub.video_url?sub.video_url:'')+'" placeholder="https://www.youtube.com/watch?v=…"></label><p class="youtube-link-note">Paste a YouTube watch, youtu.be or Shorts link. '+(draftMode?'Submissions are closed, so this will be saved privately as a draft.':'Your project will be sent to the review queue.')+'</p><button class="btn primary" type="submit">'+(draftMode?'Save private draft':sub?'Save changes':'Submit project')+'</button><div class="dash-message" role="status"></div></form>';
 }else{
  formHtml='<div class="deadline-note">This submission is '+escapeHtml(sub.status)+'. Approved or rejected submissions cannot be edited here.</div>';
 }
 const embedUrl=sub&&sub.video_url?getYoutubeEmbedUrl(sub.video_url):null;
 const video=embedUrl?'<div class="youtube-player"><iframe src="'+escapeHtml(embedUrl)+'" title="'+escapeHtml(sub.title)+' video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>':(sub&&sub.video_url?'<p class="dash-help"><a href="'+escapeHtml(sub.video_url)+'" target="_blank" rel="noopener">Open submitted video</a></p>':'');
 return '<article class="group-panel"><div class="group-title"><h3>'+escapeHtml(group.name)+'</h3>'+status+'</div><ul class="roster">'+roster+'</ul>'+(sub?'<div style="font-size:13px"><strong>'+escapeHtml(sub.title)+'</strong><p class="dash-help">'+escapeHtml(sub.description)+'</p></div>'+video+feedback:'')+formHtml+'</article>';
}
async function loadDashboard(user){
 if(!user)return;
 activeUser=user;currentArenaRole='team';dashboard.classList.add('visible');voterDashboard.classList.remove('visible');document.body.classList.add('authenticated-view');
 const profile=await supabase.from('profiles').select('full_name').eq('id',user.id).maybeSingle();
 const displayName=profile.data&&profile.data.full_name?profile.data.full_name:(user.email||'Student').split('@')[0];
 document.getElementById('dashWelcome').textContent='Welcome, '+displayName;
 const settings=await supabase.from('competition_settings').select('title,submissions_open,submission_deadline').eq('id',true).maybeSingle();
 if(settings.error)throw settings.error;
 competitionSettings=settings.data;
 const notice=document.getElementById('competitionNotice');
 if(competitionSettings){notice.textContent=(competitionSettings.submissions_open?'Submissions are open':'Submissions are currently closed')+' · Deadline: '+formatDeadline(competitionSettings.submission_deadline)+(submissionWindowOpen()?'':' · You can save project details as a private draft.')}
 const voteStats=await supabase.rpc('get_my_team_vote_counts');if(voteStats.error)throw voteStats.error;const statsEl=document.getElementById('teamVoteStats');const statRows=voteStats.data||[];statsEl.innerHTML='<h3>Your vote dashboard</h3>'+(statRows.length?'<table class="vote-table"><thead><tr><th>Team / project</th><th>Status</th><th>Votes</th></tr></thead><tbody>'+statRows.map(x=>'<tr><td>'+escapeHtml(x.project_title||x.team_name)+'</td><td>'+escapeHtml(x.submission_status||'Not submitted')+'</td><td><strong>'+Number(x.vote_count||0)+'</strong></td></tr>').join('')+'</tbody></table>':'<div class="dashboard-empty">Register your team to start tracking its votes.</div>');
 const list=document.getElementById('groupList');list.innerHTML='<div class="dashboard-empty">Loading your teams…</div>';
 const groups=await supabase.from('project_groups').select('id,name,created_at').eq('created_by',user.id).order('created_at',{ascending:false});
 if(groups.error)throw groups.error;
 if(!groups.data||!groups.data.length){list.innerHTML='<div class="dashboard-empty">No team registered yet. Use the form to create your first team.</div>';return}
 const cards=await Promise.all(groups.data.map(renderGroupCard));list.innerHTML=cards.join('');
}
async function loadVoterDashboard(user){
 if(!user)return;activeUser=user;currentArenaRole='voter';voterDashboard.classList.add('visible');dashboard.classList.remove('visible');document.body.classList.add('authenticated-view');
 const profile=await supabase.from('profiles').select('full_name').eq('id',user.id).maybeSingle();
 const displayName=profile.data?.full_name||(user.email||'Student').split('@')[0];document.getElementById('voterWelcome').textContent='Welcome, '+displayName;
 const [settings,projects,votes]=await Promise.all([
  supabase.from('competition_settings').select('voting_open,voting_deadline').eq('id',true).maybeSingle(),
  supabase.rpc('get_approved_arena_projects'),
  supabase.from('votes').select('submission_id').eq('voter_id',user.id)
 ]);
 if(settings.error)throw settings.error;if(projects.error)throw projects.error;if(votes.error)throw votes.error;
 const votingOpen=!!settings.data?.voting_open&&!!settings.data?.voting_deadline&&new Date(settings.data.voting_deadline).getTime()>Date.now();
 const notice=document.getElementById('votingNotice');notice.textContent=(votingOpen?'Voting is open':'Voting is currently closed')+(settings.data?.voting_deadline?' · Deadline: '+new Date(settings.data.voting_deadline).toLocaleString():'');
 const list=document.getElementById('voterProjectList');const items=projects.data||[];
 if(!items.length){list.innerHTML='<div class="dashboard-empty">No approved projects are available yet.</div>';return}
 const hasVoted=(votes.data||[]).length>0;
 list.innerHTML=items.map(x=>{const embed=getYoutubeEmbedUrl(x.video_url||'');return '<article class="voter-card" data-vote-submission="'+escapeHtml(x.submission_id)+'"><div class="eyebrow">'+escapeHtml(x.team_name||'Student team')+'</div><h3>'+escapeHtml(x.project_title)+'</h3><p>'+escapeHtml(x.project_description)+'</p>'+(embed?'<iframe src="'+escapeHtml(embed)+'" title="'+escapeHtml(x.project_title)+' video" loading="lazy" allowfullscreen></iframe>':'')+'<button class="btn primary" type="button" data-cast-vote '+(hasVoted||!votingOpen?'disabled':'')+'>'+(hasVoted?'Vote already submitted':votingOpen?'Vote for this project':'Voting closed')+'</button></article>'}).join('');
 document.getElementById('voterMessage').textContent=hasVoted?'Your vote has been recorded. You can only vote once.':'You can cast one vote while voting is open.';
}
document.getElementById('refreshVoter').addEventListener('click',async()=>{try{await loadVoterDashboard(activeUser)}catch(e){document.getElementById('voterMessage').textContent=e.message||'Could not refresh projects.'}});
document.getElementById('voterProjectList').addEventListener('click',async e=>{
 const btn=e.target.closest('[data-cast-vote]');if(!btn)return;const card=btn.closest('[data-vote-submission]');btn.disabled=true;btn.textContent='Submitting vote…';
 try{const {error}=await supabase.from('votes').insert({voter_id:activeUser.id,submission_id:card.dataset.voteSubmission});if(error)throw error;await loadVoterDashboard(activeUser)}
 catch(err){document.getElementById('voterMessage').textContent=err.message||'Could not submit your vote.';btn.disabled=false;btn.textContent='Try again'}
});
['headerChooseRole','chooseRoleBtn','ctaChooseRole'].forEach(id=>document.getElementById(id)?.addEventListener('click',()=>roleChooser.scrollIntoView({behavior:'smooth'})));
document.getElementById('refreshDashboard').addEventListener('click',async()=>{try{await loadDashboard(activeUser)}catch(e){dashMessage('groupMessage',e.message,true)}});
document.getElementById('createGroupForm').addEventListener('submit',async e=>{
 e.preventDefault();if(!activeUser){dashMessage('groupMessage','Please sign in first.',true);return}
 const form=e.currentTarget,button=form.querySelector('button[type="submit"]');button.disabled=true;button.textContent='Creating team…';
 let createdGroup=null;
 try{
  const fd=new FormData(form),groupName=String(fd.get('groupName')||'').trim();
  const names=[...form.querySelectorAll('input[name="memberName"]')].map(x=>x.value.trim());
  const rolls=[...form.querySelectorAll('input[name="rollNumber"]')].map(x=>x.value.trim());
  if(!groupName||names.some(x=>!x)||rolls.some(x=>!x))throw new Error('Complete the team name and every member name and roll number.');
  if(new Set(rolls.map(x=>x.toLowerCase())).size!==rolls.length)throw new Error('Each member must have a different roll number.');
  const inserted=await supabase.from('project_groups').insert({name:groupName,created_by:activeUser.id}).select('id').single();
  if(inserted.error)throw inserted.error;createdGroup=inserted.data;
  const memberRows=names.map((name,i)=>({group_id:createdGroup.id,member_name:name,roll_number:rolls[i],user_id:i===0?activeUser.id:null}));
  const added=await supabase.from('group_members').insert(memberRows);
  if(added.error){await supabase.from('project_groups').delete().eq('id',createdGroup.id);createdGroup=null;throw added.error}
  form.reset();document.getElementById('memberRows').innerHTML='<div class="member-row"><input name="memberName" required maxlength="100" placeholder="Your full name"><input name="rollNumber" required maxlength="40" placeholder="Your roll number"><button class="member-remove" type="button" hidden>Remove</button></div>';
  dashMessage('groupMessage','Team registered successfully.');await loadDashboard(activeUser);
 }catch(err){dashMessage('groupMessage',err.message||'Could not create team.',true)}
 finally{button.disabled=false;button.textContent='Create team'}
});
document.getElementById('groupList').addEventListener('submit',async e=>{
 const form=e.target.closest('.submission-form');if(!form)return;e.preventDefault();
 const button=form.querySelector('button[type="submit"]'),messageEl=form.querySelector('.dash-message');button.disabled=true;button.textContent='Saving…';messageEl.textContent='';
 let uploadedPath=null;
 try{
  const isOpen=submissionWindowOpen();
  const fd=new FormData(form),groupId=form.dataset.group,submissionId=form.dataset.submission;
  const title=String(fd.get('title')||'').trim(),description=String(fd.get('description')||'').trim(),videoUrl=String(fd.get('videoUrl')||'').trim();
  if(!title||!description)throw new Error('Enter a project title and description.');
  if(!videoUrl)throw new Error('Paste your YouTube video link.');
  if(!getYoutubeEmbedUrl(videoUrl))throw new Error('Enter a valid YouTube link (watch, youtu.be or Shorts).');
  const payload={title,description,video_url:videoUrl,video_path:null,status:isOpen?'pending':'draft',updated_at:new Date().toISOString()};
  let saved;
  if(submissionId)saved=await supabase.from('project_submissions').update(payload).eq('id',submissionId);
  else saved=await supabase.from('project_submissions').insert({...payload,group_id:groupId});
  if(saved.error)throw saved.error;
  messageEl.textContent=isOpen?'Submission sent for review.':'Private draft saved. It will stay hidden until submissions open and you submit it.';await loadDashboard(activeUser);
 }catch(err){messageEl.textContent=err.message||'Could not save submission.';messageEl.style.color='#a33'}
 finally{button.disabled=false;button.textContent=form.dataset.submission?'Save changes':'Submit project'}
});



function adminMsg(id,t,bad=false){const el=document.getElementById(id);if(el){el.textContent=t||'';el.style.color=bad?'#a33':'var(--green)'}}
function localDate(v){if(!v)return '';const d=new Date(v);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16)}
function isoDate(v){return v?new Date(v).toISOString():null}
async function refreshAdminVoteCounts(){if(!isArenaAdmin)return;const box=document.getElementById('adminResults');try{const {data,error}=await supabase.rpc('get_arena_results');if(error)throw error;box.innerHTML=(data||[]).length?data.map((x,i)=>'<div class="admin-result"><span>'+escapeHtml(x.project_title)+' · '+escapeHtml(x.group_name)+'</span><strong>'+Number(x.vote_count||0)+' votes</strong></div>').join(''):'No approved projects or votes yet.'}catch(e){box.textContent='Could not load vote totals: '+(e.message||'Access denied');throw e}}
function startAdminVotingClock(){if(adminClockInterval)clearInterval(adminClockInterval);const tick=()=>{const timer=document.getElementById('adminVotingCountdown'),state=document.getElementById('adminVotingState');if(!timer||!state)return;if(!adminVotingActive||!adminVotingDeadlineMs){timer.textContent='Voting is stopped';state.textContent='Set a future deadline, then select Start voting.';return}const remaining=adminVotingDeadlineMs-Date.now();if(remaining<=0){adminVotingActive=false;timer.textContent='00:00:00';state.textContent='Voting deadline reached. New votes are blocked.';document.getElementById('adminVotingOpen').checked=false;supabase.from('competition_settings').update({voting_open:false,updated_at:new Date().toISOString()}).eq('id',true).then(({error})=>{if(error)console.error(error);refreshAdminVoteCounts()});return}const total=Math.floor(remaining/1000),days=Math.floor(total/86400),hours=Math.floor((total%86400)/3600),minutes=Math.floor((total%3600)/60),seconds=total%60;timer.textContent=(days?days+'d ':'')+[hours,minutes,seconds].map(n=>String(n).padStart(2,'0')).join(':');state.textContent='Voting is live · closes '+new Date(adminVotingDeadlineMs).toLocaleString()};tick();adminClockInterval=setInterval(tick,1000)}
async function setAdminVotingState(open){const btn=document.getElementById(open?'startVotingNow':'stopVotingNow');btn.disabled=true;try{let deadline=adminVotingDeadlineMs;if(open){const value=document.getElementById('adminVotingDeadline').value;if(!value)throw new Error('Choose a voting deadline first.');deadline=new Date(value).getTime();if(!Number.isFinite(deadline)||deadline<=Date.now())throw new Error('The voting deadline must be in the future.')}const payload={voting_open:open,voting_deadline:open?new Date(deadline).toISOString():document.getElementById('adminVotingDeadline').value?new Date(document.getElementById('adminVotingDeadline').value).toISOString():null,updated_at:new Date().toISOString()};const {error}=await supabase.from('competition_settings').update(payload).eq('id',true);if(error)throw error;adminMsg('adminSettingsMessage',open?'Voting started. The countdown is running.':'Voting stopped. No more votes can be submitted.');await loadAdminDashboard()}catch(e){adminMsg('adminSettingsMessage',e.message||'Could not change voting status.',true)}finally{btn.disabled=false}}
document.getElementById('startVotingNow').addEventListener('click',()=>setAdminVotingState(true));document.getElementById('stopVotingNow').addEventListener('click',()=>setAdminVotingState(false));
async function checkArenaAdmin(){const {data,error}=await supabase.rpc('is_arena_admin');if(error)throw error;isArenaAdmin=Boolean(data);adminDashboard.classList.toggle('visible',isArenaAdmin);if(isArenaAdmin)await loadAdminDashboard()}
async function loadAdminDashboard(){if(!isArenaAdmin)return;const [a,b,g]=await Promise.all([supabase.from('competition_settings').select('*').eq('id',true).single(),supabase.from('project_submissions').select('id,group_id,title,description,video_url,status,admin_feedback,submitted_at').order('submitted_at',{ascending:false}),supabase.from('project_groups').select('id,name')]);if(a.error)throw a.error;if(b.error)throw b.error;if(g.error)throw g.error;const s=a.data,subs=b.data||[],groups=g.data||[],gm=new Map(groups.map(x=>[x.id,x.name]));if(s.voting_open&&(!s.voting_deadline||new Date(s.voting_deadline).getTime()<=Date.now())){const closed=await supabase.from('competition_settings').update({voting_open:false,updated_at:new Date().toISOString()}).eq('id',true);if(closed.error)throw closed.error;s.voting_open=false;}document.getElementById('adminTitle').value=s.title||'';document.getElementById('adminSubmissionDeadline').value=localDate(s.submission_deadline);document.getElementById('adminVotingDeadline').value=localDate(s.voting_deadline);document.getElementById('adminSubmissionsOpen').checked=!!s.submissions_open;document.getElementById('adminVotingOpen').checked=!!s.voting_open;document.getElementById('adminResultsPublished').checked=!!s.results_published;document.getElementById('adminTotal').textContent=subs.length;document.getElementById('adminPending').textContent=subs.filter(x=>x.status==='pending').length;document.getElementById('adminApproved').textContent=subs.filter(x=>x.status==='approved').length;const list=document.getElementById('adminSubmissionList');list.innerHTML=subs.length?subs.map(x=>{const embed=getYoutubeEmbedUrl(x.video_url||'');return '<article class="admin-submission" data-submission-id="'+escapeHtml(x.id)+'"><div class="group-title"><div><h4>'+escapeHtml(x.title)+'</h4><span class="dash-help">'+escapeHtml(gm.get(x.group_id)||'Team')+' · '+escapeHtml(new Date(x.submitted_at).toLocaleString())+'</span></div><span class="dash-status '+escapeHtml(x.status)+'">'+escapeHtml(x.status)+'</span></div><p>'+escapeHtml(x.description)+'</p>'+(embed?'<iframe class="admin-video" src="'+escapeHtml(embed)+'" title="Project demo" loading="lazy" allowfullscreen></iframe>':'')+'<label class="dash-field">Admin feedback<textarea class="admin-feedback" maxlength="2000" placeholder="Optional feedback">'+escapeHtml(x.admin_feedback||'')+'</textarea></label><div class="admin-actions"><button class="btn primary" data-review="approved" type="button">Approve</button><button class="btn danger" data-review="rejected" type="button">Reject</button><button class="btn" data-review="pending" type="button">Set pending</button></div><div class="admin-message" role="status"></div></article>'}).join(''):'<div class="dashboard-empty">No project submissions yet.</div>';adminVotingDeadlineMs=s.voting_deadline?new Date(s.voting_deadline).getTime():null;adminVotingActive=!!s.voting_open&&!!adminVotingDeadlineMs&&adminVotingDeadlineMs>Date.now();startAdminVotingClock();await refreshAdminVoteCounts();if(adminCountsInterval)clearInterval(adminCountsInterval);adminCountsInterval=setInterval(()=>{if(isArenaAdmin)refreshAdminVoteCounts().catch(e=>console.warn('Vote count refresh failed',e))},15000)}
document.getElementById('adminEntry').addEventListener('click',e=>{e.preventDefault();if(isArenaAdmin){adminDashboard.scrollIntoView({behavior:'smooth'});return}openAuth('signin');showMessage('Sign in with an account that has administrator access.')});
document.getElementById('refreshAdmin').addEventListener('click',async()=>{try{await loadAdminDashboard();adminMsg('adminSettingsMessage','Dashboard refreshed.')}catch(e){adminMsg('adminSettingsMessage',e.message,true)}});
document.getElementById('saveAdminSettings').addEventListener('click',async()=>{const btn=document.getElementById('saveAdminSettings');btn.disabled=true;try{const p={title:document.getElementById('adminTitle').value.trim(),submission_deadline:isoDate(document.getElementById('adminSubmissionDeadline').value),voting_deadline:isoDate(document.getElementById('adminVotingDeadline').value),submissions_open:document.getElementById('adminSubmissionsOpen').checked,voting_open:document.getElementById('adminVotingOpen').checked,results_published:document.getElementById('adminResultsPublished').checked,updated_at:new Date().toISOString()};if(!p.title)throw new Error('Enter a competition title.');if(p.voting_open&&(!p.voting_deadline||new Date(p.voting_deadline).getTime()<=Date.now()))throw new Error('To open voting, set a future voting deadline or use Start voting.');const {error}=await supabase.from('competition_settings').update(p).eq('id',true);if(error)throw error;adminMsg('adminSettingsMessage','Competition settings saved.');await loadAdminDashboard()}catch(e){adminMsg('adminSettingsMessage',e.message||'Could not save settings.',true)}finally{btn.disabled=false}});
document.getElementById('adminSubmissionList').addEventListener('click',async e=>{const btn=e.target.closest('[data-review]');if(!btn)return;const card=btn.closest('[data-submission-id]');btn.disabled=true;const msg=card.querySelector('.admin-message');try{const {error}=await supabase.from('project_submissions').update({status:btn.dataset.review,admin_feedback:card.querySelector('.admin-feedback').value.trim(),updated_at:new Date().toISOString()}).eq('id',card.dataset.submissionId);if(error)throw error;msg.textContent='Submission updated.';await loadAdminDashboard()}catch(err){msg.textContent=err.message||'Could not update submission.';msg.style.color='#a33'}finally{btn.disabled=false}});

const toast=document.querySelector('.toast');let timer;document.querySelectorAll('[data-toast]').forEach(b=>b.addEventListener('click',()=>{toast.textContent=b.dataset.toast;toast.classList.add('show');clearTimeout(timer);timer=setTimeout(()=>toast.classList.remove('show'),2800)}));
