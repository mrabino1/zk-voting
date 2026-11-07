/** FAQ copy for zk-voting.org/faq (Portuguese, Brazil). {brand} is the display name. */

export default {
  "faq": {
    "meta": {
      "title": "Perguntas · {brand}",
      "description": "Perguntas sobre {brand}: cédulas privadas, enquetes e votações, auto-hospedagem, e o que este projeto não faz. Não há nada para depositar."
    },
    "navLabel": "Seções das perguntas",
    "menu": "Seções",
    "homeLink": "Início",
    "onThisPage": "Nesta página",
    "pager": {
      "prev": "Anterior",
      "next": "Próximo"
    },
    "group": {
      "start": "Primeiros passos",
      "faqs": "Perguntas frequentes",
      "info": "Informações"
    },
    "links": {
      "resources": "Recursos",
      "home": "Início",
      "faq": "Estas perguntas",
      "poll": "Enquete e votação",
      "vision": "Visão",
      "host": "Auto-hospedar",
      "forum": "Fórum da comunidade",
      "demo": "Demonstração de votação",
      "github": "Código-fonte",
      "email": "E-mail",
      "docs": "Guias do nó"
    },
    "deploy": {
      "terminalLabel": "Início rápido da auto-hospedagem",
      "terminalComment": "# opere o seu próprio nó",
      "title": "Como implantar",
      "nav": "Como implantar",
      "lede": "Opere o nó você mesmo. Não implante um pool, uma ponte nem uma venda de tokens. Essas peças não estão neste software.",
      "start": {
        "q": "Como inicio um nó?",
        "a": "A partir de uma cópia de trabalho, copie o arquivo de ambiente de exemplo e então inicie a pilha. O nó responde a uma verificação de saúde. Este site é só a explicação. Ele não é o nó."
      },
      "platforms": {
        "q": "Quais plataformas?",
        "a": "Docker Compose, Coolify, Dokploy ou CapRover. O nó pode ficar privado atrás de um sidecar Tailscale."
      },
      "not": {
        "q": "O que não devo implantar?",
        "a": "Não implante um pool de empréstimo, uma ponte para depósitos nem uma venda de tokens. Este software não os inclui. Fixe os contratos do nó desse grupo e não trate a demonstração como uma cerimônia concluída."
      }
    },
    "welcome": {
      "title": "Boas-vindas",
      "nav": "Boas-vindas",
      "lede": "Notas para eleitores, autoridades e quem decide se hospeda um nó. Isto não é um protocolo de empréstimo. Não há nada para depositar.",
      "p1": "{brand} é um modo de código aberto e sem fins lucrativos para um grupo realizar as próprias eleições e enquetes. Uma eleição cívica é uma pessoa, um voto, e a escolha é feita para não ser publicada. Em separado, quem opera pode abrir um sinal consultivo na rede principal da Ethereum. Esse sinal não é uma eleição cívica: o peso vem de um ERC-20 num bloco finalizado, não há inscrição, assinar é grátis e a escolha continua pública.",
      "p2": "Estas páginas seguem a página inicial. Elas explicam como uma enquete difere de uma votação, o que é público, o que é projetado para permanecer privado e como um grupo hospeda o próprio nó. Elas não prometem que uma implantação satisfaça um estatuto eleitoral.",
      "disclaimerTitle": "Aviso",
      "disclaimer": "Este site é informação geral. Não é aconselhamento jurídico nem uma certificação. {brand} está em desenvolvimento ativo. Os testes usam um verificador simulado, e a cerimônia de configuração confiável ainda não aconteceu. Não use hoje para uma eleição vinculante. Aprovar uma votação nunca executa nada sozinha."
    },
    "quick-links": {
      "title": "Ligações rápidas",
      "nav": "Ligações rápidas",
      "lede": "As páginas e as salas que existem para este projeto. Não há tela de tomar emprestado, nem tela de emprestar, nem um lugar para depositar fundos.",
      "note": "Mercados, liquidações, leilões de reservas, programas de incentivo e faixas de preço não fazem parte de {brand}. Se uma página pedir para depositar ou comprar um token, não é este projeto."
    },
    "glossary": {
      "title": "Glossário",
      "nav": "Glossário",
      "lede": "Definições curtas. Elas acompanham a página inicial e deixam de fora o que este projeto não faz.",
      "note": "As definições são simplificadas e podem não ser uma especificação completa.",
      "civic": {
        "term": "Eleição cívica",
        "def": "Uma pessoa, um voto, com inscrição e voto secreto."
      },
      "signal": {
        "term": "Sinal com token",
        "def": "Uma enquete consultiva ponderada por um ERC-20 num bloco finalizado da Ethereum. Não há inscrição, e a escolha continua pública. Ela não usa a L2 cívica."
      },
      "poll": {
        "term": "Enquete",
        "def": "Uma disputa cívica que publica as contagens por opção num calendário por hora com atraso depois de uma barreira. O comparecimento usa esse mesmo calendário por hora."
      },
      "vote": {
        "term": "Votação",
        "def": "Uma disputa cívica que mantém as opções seladas até o prazo final. O comparecimento é publicado num calendário por hora com atraso. Não há contagens provisórias por opção."
      },
      "roll": {
        "term": "Lista",
        "def": "O conjunto apto de uma eleição. Guarda compromissos de identidade, não nomes, endereços de carteira nem números de documento."
      },
      "commitment": {
        "term": "Compromisso de identidade",
        "def": "O valor escrito na lista. Não é um endereço de carteira nem um número de documento."
      },
      "revote": {
        "term": "Votar de novo",
        "def": "O operador decide na criação se é permitido votar de novo, e essa configuração não pode ser alterada depois. Se for permitido, conta a última cédula antes do prazo. Se não, uma segunda cédula é rejeitada."
      },
      "gate": {
        "term": "Barreira",
        "def": "Numa enquete, as contagens ficam ocultas até que 100 eleitores tenham enviado sua primeira cédula ou chegue o fim previsto, o que vier primeiro."
      },
      "block": {
        "term": "Bloco por hora",
        "def": "Uma fatia publicada das contagens por opção de uma enquete. Uma hora com menos de 10 cédulas segue adiante até um bloco ter pelo menos 10. Um bloco publicado é projetado para ficar como foi publicado."
      },
      "receipt": {
        "term": "Recibo",
        "def": "Evidência de que uma cédula foi aceita. São hashes, projetados para não mostrar como você votou."
      },
      "guardian": {
        "term": "Guardião",
        "def": "Uma das partes k-of-n que podem decifrar uma votação só em conjunto no prazo final. O projeto não dá ao operador nenhuma parte da chave."
      },
      "l2": {
        "term": "L2 cívica",
        "def": "Um sequenciador e um provador feitos para esse fim, que um grupo opera para as próprias eleições. Liquida lotes na Ethereum. Não é uma cadeia de uso geral."
      },
      "uuid": {
        "term": "UUID da eleição",
        "def": "O identificador público de uma eleição, único dentro dessa L2. A Ethereum identifica um lote pelo hash do ID da L2 e deste UUID."
      },
      "mock": {
        "term": "Verificador simulado",
        "def": "O substituto usado nos testes no lugar de uma conferência real da prova. Com ele, a recusa de um eleitor que não está pré-aprovado ainda não é exigida."
      }
    },
    "general": {
      "title": "Geral",
      "nav": "Geral",
      "lede": "O que é o projeto, o que custa e o que ele se recusa a afirmar.",
      "what": {
        "q": "O que é {brand}?",
        "a": "Um sistema de votação de código aberto e sem fins lucrativos que qualquer grupo pode operar por si. Provas de conhecimento zero são projetadas para mostrar que só pessoas aptas votaram, uma vez cada, e que a apuração publicada corresponde às cédulas. Os testes usam por enquanto um verificador simulado. As escolhas individuais são projetadas para não serem publicadas."
      },
      "features": {
        "q": "Quais são os recursos principais?",
        "a": "A auto-hospedagem, e uma pessoa, um voto numa eleição cívica. Um sinal consultivo separado que não é um voto secreto. Enquetes com contagens por opção num horário com atraso depois de uma barreira, e votações que ficam seladas até o prazo final. Cadastro público e códigos de desqualificação. Recibos que são hashes. Uma licença AGPL, sem taxa para quem vota e sem token de produto."
      },
      "who": {
        "q": "Para quem é?",
        "a": "Qualquer órgão que precise de uma lista, de uma cédula e de um resultado que as pessoas possam conferir: cidades, condados, sindicatos, cooperativas, conselhos, escolas, clubes e observadores."
      },
      "fees": {
        "q": "Quais são as taxas?",
        "a": "Quem vota não é cobrado. Não há depósito, não há taxa de abertura e não há juros. Quem hospeda paga os próprios servidores. Na L2 cívica, a chave Ethereum do operador, com fundos mínimos, paga o envio dos lotes. Num sinal com token, assinar uma cédula é grátis. Delegar esse token é a transação que custa gás."
      },
      "audit": {
        "q": "Ele foi auditado?",
        "a": "Não como sistema pronto. O código é público sob AGPL-3.0-or-later. Os testes usam um verificador simulado, o primeiro caminho de prova está em andamento e a cerimônia de configuração confiável ainda não aconteceu. Não há um programa pago de recompensa por falhas."
      },
      "down": {
        "q": "E se este site sair do ar?",
        "a": "Este site só explica o projeto. A eleição de um grupo roda no nó que esse grupo hospeda. O software é de código aberto, então outra pessoa pode servir as mesmas páginas a partir do repositório. Um nó também pode ficar numa rede privada."
      },
      "admin": {
        "q": "Alguém controla todas as eleições?",
        "a": "Não. Cada grupo opera o próprio nó e é dono da própria lista. As autoridades desse nó criam eleições, congelam a lista, registram desqualificações e publicam a apuração. Esses trabalhos não são uma porta dos fundos que publique as opções."
      }
    },
    "elections": {
      "title": "Eleições",
      "nav": "Eleições",
      "lede": "Uma disputa com uma lista e uma cédula. Não um pool de liquidez.",
      "what": {
        "q": "O que é uma eleição aqui?",
        "a": "Uma disputa com uma lista, uma cédula e um resultado publicado. Na criação, o operador escolhe uma enquete ou uma votação, e se é permitido votar de novo. Essa configuração não pode ser alterada depois."
      },
      "many": {
        "q": "Um nó pode realizar muitas eleições?",
        "a": "Sim. Uma L2 cívica pode conter qualquer número de eleições. Qualquer pessoa pode operar uma L2 cívica, e não há limite de quantas existem."
      },
      "id": {
        "q": "Como uma eleição é identificada?",
        "a": "Por um UUID de eleição, único dentro dessa L2. Os lotes liquidados na Ethereum são identificados pelo hash do ID da L2 e o UUID da eleição, então dois grupos não compartilham um registro só por reutilizar um nome."
      },
      "districts": {
        "q": "Os distritos podem ser aninhados?",
        "a": "Sim. Uma cidade, um condado ou um distrito pode conduzir eleições e referendos com distritos aninhados, medidas e artigos. Essa estrutura vive na lista do grupo. Não é uma cadeia separada."
      }
    },
    "registration": {
      "title": "Cadastro",
      "nav": "Cadastro",
      "lede": "Entrar numa lista. Nada é depositado e nada é emprestado.",
      "join": {
        "q": "Como alguém entra numa eleição cívica?",
        "a": "A pessoa se cadastra com uma chave de acesso, uma carteira, um e-mail ou um documento. A lista guarda um compromisso de identidade. Cadastrar-se numa eleição não inscreve a pessoa em cada disputa do nó."
      },
      "stored": {
        "q": "O que é guardado na lista?",
        "a": "Um compromisso de identidade. Não um nome, não um endereço de carteira e não um número de documento."
      },
      "deposit": {
        "q": "O cadastro é um depósito?",
        "a": "Não. Nada de valor é bloqueado, custodiado ou emprestado. Não há garantia nem faixa de preço."
      },
      "token": {
        "q": "Um saldo de token me coloca na lista?",
        "a": "Não numa eleição cívica. Um sinal com token é separado: manter o ERC-20 escolhido num bloco finalizado é a credencial, não há cadastro e a escolha continua pública."
      }
    },
    "ballots": {
      "title": "Cédulas",
      "nav": "Cédulas",
      "lede": "Marcar uma opção e provar que você tinha permissão para marcá-la.",
      "cast": {
        "q": "Como uma cédula é enviada?",
        "a": "O eleitor marca uma opção e envia uma prova projetada para mostrar que está na lista congelada e não foi desqualificado. Quem vota não é cobrado por esse envio."
      },
      "change": {
        "q": "Posso mudar meu voto?",
        "a": "Só se o operador permitiu votar de novo quando a eleição foi criada. O operador decide na criação se é permitido votar de novo, e essa configuração não pode ser alterada depois. Se for permitido, conta a última cédula antes do prazo. Se não, uma segunda cédula é rejeitada."
      },
      "proof": {
        "q": "O que a prova mostra?",
        "a": "Que uma pessoa apta votou, uma vez, do modo que essa eleição permite, e que a cédula está bem formada. Ela é projetada para não mostrar qual opção foi marcada. Com o verificador simulado nos testes, esta verificação ainda não é exigida."
      },
      "back": {
        "q": "O que eu recebo de volta?",
        "a": "Um recibo de hashes, projetado para não mostrar como você votou. Cada cédula, inclusive um novo voto, recebe um."
      }
    },
    "polls": {
      "title": "Enquetes",
      "nav": "Enquetes",
      "lede": "Uma disputa cívica que pode mostrar contagens por opção em andamento, com atraso, depois de uma barreira.",
      "what": {
        "q": "O que é uma enquete?",
        "a": "Uma disputa cívica que publica as contagens por opção num calendário por hora com atraso depois de uma barreira. O comparecimento é publicado num calendário por hora com atraso tanto numa enquete como numa votação."
      },
      "when": {
        "q": "Quando aparecem as contagens por opção?",
        "a": "Quando 100 eleitores tiverem enviado sua primeira cédula, ou ao chegar o fim previsto, o que vier primeiro. Cada hora é publicada 30 minutos depois de fechar."
      },
      "small": {
        "q": "E se uma hora for pequena?",
        "a": "Uma hora com menos de 10 cédulas segue adiante até um bloco ter pelo menos 10."
      },
      "blocks": {
        "q": "Os blocos por hora publicados mudam?",
        "a": "Não. Os blocos por hora publicados são projetados para ficar como foram publicados. Se votar de novo foi permitido, as cédulas substitutas aparecem só na apuração final."
      }
    },
    "votes": {
      "title": "Votações",
      "nav": "Votações",
      "lede": "Uma disputa cívica cujas opções ficam seladas até o prazo final.",
      "what": {
        "q": "O que é uma votação?",
        "a": "Uma disputa cívica que mantém as opções seladas até o prazo final. O comparecimento é publicado num calendário por hora com atraso. Não há contagens provisórias por opção."
      },
      "read": {
        "q": "Quando as opções podem ser lidas?",
        "a": "No prazo final, e só em conjunto. As opções são cifradas com uma chave pública publicada na L2. A chave privada correspondente é dividida entre os guardiões com o compartilhamento de segredo de Shamir, projetado para que nenhuma parte sozinha, nem mesmo o operador, consiga decifrar antes da hora. O projeto não dá ao operador nenhuma parte da chave."
      },
      "why": {
        "q": "Por que escolher uma votação em vez de uma enquete?",
        "a": "Quando uma contagem por opção em andamento aumentaria a pressão. Nada que o eleitor recebe é projetado para provar sua escolha a quem o pressiona."
      },
      "rank": {
        "q": "Uma votação pode ser por ordem de preferência?",
        "a": "Sim, como opção. A votação por ordem de preferência também existe nas enquetes. Numa votação selada, os guardiões então veem cada classificação, não a identidade."
      }
    },
    "results": {
      "title": "Resultados",
      "nav": "Resultados",
      "lede": "O que fica visível enquanto uma disputa está aberta e o que é publicado depois do prazo final.",
      "open": {
        "q": "O que é publicado enquanto uma disputa está aberta?",
        "a": "O comparecimento é publicado num calendário por hora com atraso nos dois tipos. Uma enquete também publica as contagens por opção nesse calendário quando 100 eleitores tiverem enviado sua primeira cédula, ou ao chegar o fim previsto, o que vier primeiro. Uma votação publica as opções só no prazo final."
      },
      "deadline": {
        "q": "O que acontece no prazo final?",
        "a": "Nenhuma cédula é mais aceita. Um lote final vai para a Ethereum no prazo. Uma janela de impugnação, que precisa durar mais que zero, vem antes da apuração final."
      },
      "extra": {
        "q": "O que é o lote suplementar?",
        "a": "Após o período de tolerância, qualquer pessoa pode publicar um lote final que falte e o lote suplementar, antes da apuração final."
      },
      "execute": {
        "q": "A apuração executa a decisão?",
        "a": "Não. Aprovar uma votação nunca executa nada sozinha. Os resultados são verificáveis. Agir sobre eles fica com as pessoas."
      },
      "check": {
        "q": "Como alguém de fora pode conferir?",
        "a": "Qualquer pessoa pode verificar que os totais publicados correspondem às cédulas aceitas. Um auditor independente deve poder reconstruir um resultado publicado sem o banco de dados privado do operador. Até existir um verificador agregado real, a contagem é conferida somando textos cifrados na cadeia."
      }
    },
    "privacy": {
      "title": "Privacidade",
      "nav": "Privacidade",
      "lede": "A escolha é o segredo. O processo é a parte pública.",
      "private": {
        "q": "O que é projetado para permanecer privado?",
        "a": "A opção de uma cédula cívica. Ela é projetada para nunca ser um campo legível numa transação ou num banco de dados. Os recibos são hashes, projetados para não mostrar como você votou."
      },
      "public": {
        "q": "O que é público?",
        "a": "Cadastros e códigos de desqualificação são públicos. O comparecimento é publicado num calendário por hora com atraso nos dois tipos. Uma enquete também publica as contagens por opção nesse calendário quando 100 eleitores tiverem enviado sua primeira cédula, ou ao chegar o fim previsto, o que vier primeiro. A apuração final também é pública."
      },
      "delay": {
        "q": "Por que esperar para publicar o comparecimento?",
        "a": "Para que sair de um local de votação não possa ser associado a um pulso ao vivo. O atraso é o calendário por hora. As contagens não levam preenchimento."
      },
      "signal": {
        "q": "Um sinal com token é privado?",
        "a": "Não. Num sinal com token a escolha continua pública. O voto secreto é a eleição cívica."
      }
    },
    "officers": {
      "title": "Autoridades",
      "nav": "Autoridades",
      "lede": "O grupo que hospeda o nó é dono da lista. As autoridades têm tarefas, não uma chave mestra.",
      "who": {
        "q": "Quem opera um nó?",
        "a": "O grupo que o hospeda. Ele é dono do nó, da lista e do registro. Não é preciso uma conta de fornecedor para começar, e não há aprisionamento de fornecedor."
      },
      "jobs": {
        "q": "O que fazem as autoridades?",
        "a": "Elas criam a eleição e a cédula, congelam a lista, aprovam o cadastro, registram uma desqualificação com um código de motivo público e publicam a apuração depois do prazo. Quem hospeda também pode publicar as próprias páginas."
      },
      "read": {
        "q": "Uma autoridade pode ler como as pessoas votaram?",
        "a": "Esse não é o projeto. As opções de uma votação são cifradas com a chave dos guardiões, e o operador não tem nenhuma parte da chave. Uma enquete publica agregados. As autoridades não recebem um fluxo privado ao vivo das opções."
      }
    },
    "dq": {
      "title": "Desqualificação",
      "nav": "Desqualificação",
      "lede": "Barrar alguém é uma mudança pública e codificada. Não é uma marca silenciosa.",
      "why": {
        "q": "Por que uma pessoa cadastrada pode ser barrada?",
        "a": "Cadastrado não é o mesmo que apto. Uma autoridade pode barrar alguém com um código de motivo declarado, por exemplo não ter a idade, não ser residente, uma duplicata ou uma ordem judicial. O código é público para que um expurgo não possa se esconder."
      },
      "evidence": {
        "q": "Para onde vai a evidência?",
        "a": "A evidência pessoal fica fora da cadeia. O registro público é o código do motivo e um hash da evidência, para que uma revisão posterior possa casar um arquivo selado com o que foi publicado."
      },
      "barred": {
        "q": "Uma pessoa barrada pode votar mesmo assim?",
        "a": "Não. O conjunto apto são as pessoas cadastradas e não desqualificadas no momento. A prova é projetada para exigir que a pessoa faça parte desse conjunto. Com o verificador simulado nos testes, esta verificação ainda não é exigida."
      }
    },
    "receipts": {
      "title": "Recibos",
      "nav": "Recibos",
      "lede": "Prova de que você votou. Não a prova da opção que você marcou.",
      "what": {
        "q": "O que há num recibo?",
        "a": "Hashes que mostram que uma cédula foi aceita. O bastante para localizá-la, não a opção que foi marcada. Se uma tela disser qual opção você escolheu, isso é uma falha."
      },
      "check": {
        "q": "Como confiro que ela foi contada?",
        "a": "No nó que realizou a eleição, abra a página do recibo e cole a prova, ou use o arquivo que o nó entregou. A conferência responde se essa cédula foi aceita. Ela não mostra um candidato."
      },
      "pressure": {
        "q": "Alguém pode exigir meu recibo como prova da minha escolha?",
        "a": "Um recibo é projetado para não mostrar como você votou. Ele não pode satisfazer quem exige uma prova da escolha. Essa recusa é intencional."
      }
    },
    "token": {
      "title": "Não é um token",
      "nav": "Não é um token",
      "lede": "Não há um token do projeto, não há recompensa por votar e não há nada para depositar.",
      "product": {
        "q": "Existe um token de {brand}?",
        "a": "Não. Não há token de produto, não há faixa paga e não há recompensa por votar. A licença é AGPL-3.0-or-later. O repositório não é um jeito de ganhar dinheiro."
      },
      "signal": {
        "q": "Então, o que é um sinal com token?",
        "a": "Um modo consultivo opcional na rede principal da Ethereum. Quem hospeda escolhe um ERC-20 já existente. O peso vem desse token num bloco finalizado. O poder de voto delegado é lido ali. Não é um voto secreto, não usa a lista cívica e o resultado não executa nada."
      },
      "markets": {
        "q": "Há programas de incentivo ou pools de liquidez?",
        "a": "Não. Não há nada para depositar, emprestar, tomar emprestado, liquidar ou leiloar. Não envie fundos a quem anuncie uma venda de tokens com este nome."
      }
    },
    "community": {
      "title": "Comunidade",
      "nav": "Comunidade",
      "lede": "Um fórum e um repositório público. Não uma rodada de subsídios.",
      "talk": {
        "q": "Onde as pessoas conversam?",
        "a": "No fórum da comunidade. Os grupos discutem usos reais, como operar um nó e o que construir em seguida."
      },
      "grants": {
        "q": "Há um programa de subsídios?",
        "a": "Não há subsídios em tokens nem uma votação de financiamento. A contribuição é a usual do código aberto: ler o código, abrir um relato ou enviar uma correção."
      },
      "help": {
        "q": "Vocês podem ajudar um grupo a entrar no ar?",
        "a": "Sim. O projeto está disponível para contratar a implementação local. Use o endereço de e-mail no rodapé do site."
      }
    },
    "runs": {
      "title": "Onde isso roda",
      "nav": "Onde isso roda",
      "lede": "As cédulas cívicas liquidam na Ethereum. Não há ponte entre mercados de empréstimo, porque não há mercados de empréstimo.",
      "land": {
        "q": "Onde chegam as cédulas cívicas?",
        "a": "Na L2 cívica do grupo, um sequenciador e um provador feitos para esse fim. Os lotes finais liquidam na Ethereum para que o registro sobreviva a qualquer operador. A atividade do dia a dia não é uma cadeia de uso geral e não faz ponte de depósitos."
      },
      "signal": {
        "q": "Onde chegam os sinais com token?",
        "a": "Só na rede principal da Ethereum. Esse modo precisa de um RPC da rede principal da Ethereum. Ele não usa a L2 cívica."
      },
      "addresses": {
        "q": "Há uma lista única de endereços oficiais de contratos?",
        "a": "Nenhuma implantação global única é publicada aqui como tabela para copiar. Cada grupo fixa os contratos que o próprio nó usa. O nó de demonstração serve para experimentar o software, não para uma eleição de produção."
      },
      "rebuild": {
        "q": "Os resultados podem ser reconstruídos se um nó desaparecer?",
        "a": "Liquidar na Ethereum é o que torna isso possível. Os resultados são projetados para serem reconstruídos a partir dos dados da L2 ou do registro da L1. Uma raiz não provada não publica nada e pode ser revertida após um prazo."
      }
    },
    "fits": {
      "title": "Como isso se encaixa",
      "nav": "Como isso se encaixa",
      "lede": "Muitas L2 cívicas independentes. Um registro compartilhado na Ethereum.",
      "picture": {
        "q": "Qual é o panorama?",
        "a": "Qualquer pessoa pode operar uma L2 cívica, e não há limite de quantas existem. Cada L2 pode conter qualquer número de eleições. Cada L2 liquida seus lotes de votos na Ethereum, identificados pelo hash do ID da L2 e o UUID da eleição."
      },
      "inside": {
        "q": "O que acontece dentro de uma L2?",
        "a": "Quem vota na borda vota de graça. Só votantes pré-aprovados são aceitos. O sequenciador agrupa os votos. A L2 calcula a raiz de estado e a contagem. A L1 consigna essa raiz a cada hora e é projetada para conferir uma prova do cálculo depois, em ordem. Até existir um verificador agregado real, a contagem é conferida somando textos cifrados na cadeia."
      },
      "drawing": {
        "q": "Onde está o diagrama?",
        "a": "A página inicial o desenha: uma vista macro de muitas L2, uma vista L2 de uma equipe eleitoral e o percurso que uma enquete e uma votação fazem até a apuração final. Essas figuras são o diagrama do protocolo."
      }
    },
    "roadmap": {
      "title": "Roteiro",
      "nav": "Roteiro",
      "lede": "O que é verdade nesta linha de desenvolvimento, e o que uma apuração não passará a fazer depois.",
      "today": {
        "q": "O que é verdade hoje?",
        "a": "Você pode ler este site e experimentar a demonstração de votação. Os testes usam um verificador simulado. A cerimônia de configuração confiável ainda não aconteceu. Não use hoje para uma eleição vinculante."
      },
      "proving": {
        "q": "Qual é o caminho de prova?",
        "a": "Uma conferência real da prova está em andamento. Com o verificador simulado nos testes, a recusa de um eleitor que não está pré-aprovado ainda não é exigida. Não descreva uma demonstração local como pronta para uma eleição vinculante."
      },
      "never": {
        "q": "O que um resultado não fará?",
        "a": "Ele não vai se executar sozinho. A apuração é evidência. Agir sobre ela fica com as pessoas. O projeto também não vai acrescentar um token de produto nem uma taxa para quem vota."
      }
    },
    "builder": {
      "title": "Kit para construir",
      "nav": "Kit para construir",
      "lede": "O repositório é o kit inicial. Bifurque-o e mantenha o rótulo de sem fins lucrativos.",
      "repo": {
        "q": "O que há no repositório?",
        "a": "O nó, a L2 cívica, os contratos e os circuitos, juntos, sob AGPL-3.0-or-later. Um grupo não deve depender de uma compilação privada de um fornecedor. Bifurque-o e mantenha o rótulo de sem fins lucrativos."
      },
      "read": {
        "q": "O que devo ler primeiro?",
        "a": "O README na raiz do repositório e depois os guias de auto-hospedagem. Cada nó em execução serve esses guias em /docs."
      },
      "agpl": {
        "q": "O que a AGPL pede a quem hospeda?",
        "a": "Se você opera um nó modificado como serviço de rede, ofereça o código-fonte correspondente às pessoas que usam esse serviço."
      }
    }
  }
};
