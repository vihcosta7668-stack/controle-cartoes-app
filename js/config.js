// Projeto do Supabase deste app. Com os dois campos preenchidos, a tela de entrada pede só
// e-mail, senha e PIN. A chave anon é pública por natureza (vai para qualquer navegador que abre
// o app); quem protege os dados é o RLS das tabelas e o cadastro de novos usuários desligado no
// Supabase (Authentication → Sign In / Providers → Allow new users to sign up). Nunca coloque
// aqui a chave service_role nem a sb_secret_….
export const SUPABASE = {
  url: '', // ex.: https://abcdefghijklmnop.supabase.co
  chave: '', // chave anon (eyJ…) ou publishable (sb_publishable_…)
};
