/** FAQ copy for zk-voting.org/faq (Spanish). {brand} is the display name. */

export default {
  "faq": {
    "meta": {
      "title": "Preguntas · {brand}",
      "description": "Preguntas sobre {brand}: boletas privadas, encuestas y votaciones, autoalojamiento, y lo que este proyecto no hace. No hay nada que depositar."
    },
    "navLabel": "Secciones de preguntas",
    "menu": "Secciones",
    "homeLink": "Inicio",
    "onThisPage": "En esta página",
    "pager": {
      "prev": "Anterior",
      "next": "Siguiente"
    },
    "group": {
      "start": "Primeros pasos",
      "faqs": "Preguntas frecuentes",
      "info": "Información"
    },
    "links": {
      "resources": "Recursos",
      "home": "Inicio",
      "faq": "Estas preguntas",
      "poll": "Encuesta y votación",
      "vision": "Visión",
      "host": "Autoalojar",
      "forum": "Foro de la comunidad",
      "demo": "Demostración de votación",
      "github": "Código fuente",
      "email": "Correo",
      "docs": "Guías del nodo"
    },
    "deploy": {
      "terminalLabel": "Inicio rápido de autoalojamiento",
      "terminalComment": "# ejecute su propio nodo",
      "title": "Cómo desplegar",
      "nav": "Cómo desplegar",
      "lede": "Ejecute el nodo usted mismo. No despliegue un fondo, un puente ni una venta de tokens. Esas piezas no están en este software.",
      "start": {
        "q": "¿Cómo arranco un nodo?",
        "a": "Desde una copia de trabajo, copie el archivo de entorno de ejemplo y luego arranque la pila. El nodo responde a una comprobación de salud. Este sitio web es solo la explicación. No es el nodo."
      },
      "platforms": {
        "q": "¿Qué plataformas?",
        "a": "Docker Compose, Coolify, Dokploy o CapRover. El nodo puede quedarse privado detrás de un sidecar de Tailscale."
      },
      "not": {
        "q": "¿Qué no debo desplegar?",
        "a": "No despliegue un fondo de préstamo, un puente para depósitos ni una venta de tokens. Este software no los incluye. Fije los contratos del nodo de ese grupo y no trate la demostración como una ceremonia terminada."
      }
    },
    "welcome": {
      "title": "Bienvenida",
      "nav": "Bienvenida",
      "lede": "Notas para votantes, autoridades y quienes deciden si alojan un nodo. Esto no es un protocolo de préstamo. No hay nada que depositar.",
      "p1": "{brand} es una forma de código abierto y sin fines de lucro para que un grupo ejecute sus propias elecciones y encuestas. Una elección cívica es una persona, un voto, y la opción está diseñada para no publicarse. Por separado, quien opera puede abrir una señal consultiva en la red principal de Ethereum. Esa señal no es una elección cívica: el peso sale de un ERC-20 en un bloque finalizado, no hay inscripción, firmar es gratis y la opción sigue siendo pública.",
      "p2": "Estas páginas siguen la página de inicio. Explican en qué se diferencia una encuesta de una votación, qué es público, qué está diseñado para seguir en privado y cómo un grupo aloja su propio nodo. No prometen que un despliegue cumpla un estatuto electoral.",
      "disclaimerTitle": "Aviso",
      "disclaimer": "Este sitio es información general. No es asesoría legal ni una certificación. {brand} está en desarrollo activo. Las pruebas usan un verificador simulado, y la ceremonia de configuración de confianza todavía no ocurre. No lo use hoy para una elección vinculante. Aprobar una votación nunca ejecuta nada por sí sola."
    },
    "quick-links": {
      "title": "Enlaces rápidos",
      "nav": "Enlaces rápidos",
      "lede": "Las páginas y las salas que existen para este proyecto. No hay una pantalla para pedir prestado, ni una pantalla para prestar, ni un lugar donde depositar fondos.",
      "note": "Los mercados, las liquidaciones, las subastas de reservas, los programas de incentivos y los tramos de precio no forman parte de {brand}. Si una página le pide depositar o comprar un token, no es este proyecto."
    },
    "glossary": {
      "title": "Glosario",
      "nav": "Glosario",
      "lede": "Definiciones breves. Coinciden con la página de inicio y dejan fuera lo que este proyecto no hace.",
      "note": "Las definiciones están simplificadas y pueden no ser una especificación completa.",
      "civic": {
        "term": "Elección cívica",
        "def": "Una persona, un voto, con inscripción y voto secreto."
      },
      "signal": {
        "term": "Señal con token",
        "def": "Una encuesta consultiva ponderada por un ERC-20 en un bloque finalizado de Ethereum. No hay inscripción y la opción sigue siendo pública. No usa la L2 cívica."
      },
      "poll": {
        "term": "Encuesta",
        "def": "Una contienda cívica que publica los recuentos por opción con un calendario horario diferido después de un umbral. La participación usa ese mismo calendario horario."
      },
      "vote": {
        "term": "Votación",
        "def": "Una contienda cívica que mantiene las opciones selladas hasta el cierre. La participación se publica con un calendario horario diferido. No hay recuentos provisionales por opción."
      },
      "roll": {
        "term": "Padrón",
        "def": "El conjunto habilitado de una elección. Guarda compromisos de identidad, no nombres, direcciones de cartera ni números de documento."
      },
      "commitment": {
        "term": "Compromiso de identidad",
        "def": "El valor escrito en el padrón. No es una dirección de cartera ni un número de documento."
      },
      "revote": {
        "term": "Volver a votar",
        "def": "El operador decide al crearla si se permite volver a votar, y esa opción no se puede cambiar después. Si se permite, cuenta la última boleta antes del cierre. Si no, se rechaza una segunda boleta."
      },
      "gate": {
        "term": "Umbral",
        "def": "En una encuesta, los recuentos por opción permanecen ocultos hasta que 100 votantes hayan emitido su primera boleta, o llegue el fin programado, lo que ocurra primero."
      },
      "block": {
        "term": "Bloque horario",
        "def": "Un tramo publicado de los recuentos por opción de una encuesta. Una hora con menos de 10 boletas se fusiona hacia adelante hasta que un bloque tenga al menos 10. Un bloque publicado está diseñado para quedarse tal como se publicó."
      },
      "receipt": {
        "term": "Recibo",
        "def": "Evidencia de que una boleta fue aceptada. Son hashes, diseñados para no mostrar cómo votaste."
      },
      "guardian": {
        "term": "Guardián",
        "def": "Una de las partes k-of-n que pueden descifrar una votación solo en conjunto al cierre. El diseño no da al operador ninguna parte de la clave."
      },
      "l2": {
        "term": "L2 cívica",
        "def": "Un secuenciador y un probador hechos a propósito que un grupo ejecuta para sus propias elecciones. Liquida lotes en Ethereum. No es una cadena de propósito general."
      },
      "uuid": {
        "term": "UUID de elección",
        "def": "El identificador público de una elección, único dentro de esa L2. Ethereum identifica un lote por el hash del ID de la L2 y este UUID."
      },
      "mock": {
        "term": "Verificador simulado",
        "def": "El sustituto que las pruebas usan en lugar de una comprobación real de la prueba. Con él, el rechazo de un votante que no está preaprobado aún no se exige."
      }
    },
    "general": {
      "title": "Cuestiones generales",
      "nav": "Cuestiones generales",
      "lede": "Qué es el proyecto, qué cuesta y qué se niega a afirmar.",
      "what": {
        "q": "¿Qué es {brand}?",
        "a": "Un sistema de votación de código abierto y sin fines de lucro que cualquier grupo puede ejecutar por sí mismo. Las pruebas de conocimiento cero están diseñadas para demostrar que solo votaron personas habilitadas, una vez cada una, y que el escrutinio publicado coincide con las boletas. Las pruebas usan por ahora un verificador simulado. Las opciones individuales están diseñadas para no publicarse."
      },
      "features": {
        "q": "¿Cuáles son las funciones principales?",
        "a": "El autoalojamiento, y una persona, un voto en una elección cívica. Una señal consultiva aparte que no es un voto secreto. Encuestas con recuentos por opción en un horario diferido después de un umbral, y votaciones que permanecen selladas hasta el cierre. Inscripción pública y códigos de inhabilitación. Recibos que son hashes. Una licencia AGPL, sin tarifa para quien vota y sin token de producto."
      },
      "who": {
        "q": "¿Para quién es?",
        "a": "Cualquier órgano que necesite un padrón, una boleta y un resultado que la gente pueda comprobar: ciudades, condados, sindicatos, cooperativas, consejos, escuelas, clubes y observadores."
      },
      "fees": {
        "q": "¿Cuáles son las tarifas?",
        "a": "A quien vota no se le cobra. No hay depósito, no hay comisión de apertura y no hay interés. Quien aloja paga sus propios servidores. En la L2 cívica, la clave de Ethereum del operador, con fondos mínimos, paga el envío de los lotes. En una señal con token, firmar una boleta es gratis. Delegar ese token es la transacción que cuesta gas."
      },
      "audit": {
        "q": "¿Se ha auditado?",
        "a": "No como sistema terminado. El código es público bajo AGPL-3.0-or-later. Las pruebas usan un verificador simulado, la primera ruta de prueba está en curso y la ceremonia de configuración de confianza todavía no ocurre. No hay un programa de pago de recompensas por fallos."
      },
      "down": {
        "q": "¿Qué pasa si este sitio web cae?",
        "a": "Este sitio web solo explica el proyecto. La elección de un grupo se ejecuta en el nodo que ese grupo aloja. El software es de código abierto, así que otra persona puede servir las mismas páginas desde el repositorio. Un nodo también puede quedarse en una red privada."
      },
      "admin": {
        "q": "¿Alguien controla todas las elecciones?",
        "a": "No. Cada grupo ejecuta su propio nodo y es dueño de su padrón. Las autoridades de ese nodo crean elecciones, congelan el padrón, registran inhabilitaciones y publican el escrutinio. Esos trabajos no son una puerta trasera que publique las opciones."
      }
    },
    "elections": {
      "title": "Elecciones",
      "nav": "Elecciones",
      "lede": "Una contienda con un padrón y una boleta. No un fondo de liquidez.",
      "what": {
        "q": "¿Qué es una elección aquí?",
        "a": "Una contienda con un padrón, una boleta y un resultado publicado. Al crearla, el operador elige una encuesta o una votación, y si se permite volver a votar. Esa opción no se puede cambiar después."
      },
      "many": {
        "q": "¿Un nodo puede ejecutar muchas elecciones?",
        "a": "Sí. Una L2 cívica puede contener cualquier número de elecciones. Cualquiera puede ejecutar una L2 cívica, y no hay límite de cuántas existen."
      },
      "id": {
        "q": "¿Cómo se identifica una elección?",
        "a": "Por un UUID de elección, único dentro de esa L2. Los lotes liquidados en Ethereum se identifican por el hash del ID de la L2 y el UUID de la elección, así dos grupos no comparten un registro solo por reutilizar un nombre."
      },
      "districts": {
        "q": "¿Los distritos pueden anidarse?",
        "a": "Sí. Una ciudad, un condado o un distrito puede ejecutar elecciones y referendos con distritos anidados, medidas y artículos. Esa estructura vive en el padrón del grupo. No es una cadena aparte."
      }
    },
    "registration": {
      "title": "Inscripción",
      "nav": "Inscripción",
      "lede": "Unirse a un padrón. No se deposita nada y no se presta nada.",
      "join": {
        "q": "¿Cómo se une alguien a una elección cívica?",
        "a": "Se inscribe con una clave de acceso, una billetera, un correo o un documento. El padrón guarda un compromiso de identidad. Inscribirse en una elección no incorpora a la persona en cada contienda del nodo."
      },
      "stored": {
        "q": "¿Qué se guarda en el padrón?",
        "a": "Un compromiso de identidad. No un nombre, no una dirección de cartera y no un número de documento."
      },
      "deposit": {
        "q": "¿La inscripción es un depósito?",
        "a": "No. No se bloquea, no se custodia ni se presta nada de valor. No hay garantía ni tramo de precio."
      },
      "token": {
        "q": "¿Un saldo de token me pone en el padrón?",
        "a": "No en una elección cívica. Una señal con token es aparte: tener el ERC-20 elegido en un bloque finalizado es la credencial, no hay alta y la opción sigue siendo pública."
      }
    },
    "ballots": {
      "title": "Boletas",
      "nav": "Boletas",
      "lede": "Marcar una opción y demostrar que se le permitió marcarla.",
      "cast": {
        "q": "¿Cómo se emite una boleta?",
        "a": "El votante marca una opción y envía una prueba diseñada para mostrar que está en el padrón congelado y no está inhabilitado. A quien vota no se le cobra ese envío."
      },
      "change": {
        "q": "¿Puedo cambiar mi voto?",
        "a": "Solo si el operador permitió volver a votar cuando se creó la elección. El operador decide al crearla si se permite volver a votar, y esa opción no se puede cambiar después. Si se permite, cuenta la última boleta antes del cierre. Si no, se rechaza una segunda boleta."
      },
      "proof": {
        "q": "¿Qué muestra la prueba?",
        "a": "Que una persona habilitada votó, una vez, del modo que esa elección permite, y que la boleta está bien formada. Está diseñada para no mostrar qué opción se marcó. Con el verificador simulado en las pruebas, esta comprobación aún no se exige."
      },
      "back": {
        "q": "¿Qué recibo de vuelta?",
        "a": "Un recibo de hashes, diseñado para no mostrar cómo votaste. Cada boleta, incluida una repetición, recibe uno."
      }
    },
    "polls": {
      "title": "Encuestas",
      "nav": "Encuestas",
      "lede": "Una contienda cívica que puede mostrar recuentos por opción en curso, con retraso, después de un umbral.",
      "what": {
        "q": "¿Qué es una encuesta?",
        "a": "Una contienda cívica que publica los recuentos por opción con un calendario horario diferido después de un umbral. La participación se publica con un calendario horario diferido tanto en una encuesta como en una votación."
      },
      "when": {
        "q": "¿Cuándo aparecen los recuentos por opción?",
        "a": "Cuando 100 votantes hayan emitido su primera boleta, o al llegar el fin programado, lo que ocurra primero. Cada hora se publica 30 minutos después de cerrarse."
      },
      "small": {
        "q": "¿Qué pasa si una hora es pequeña?",
        "a": "Una hora con menos de 10 boletas se fusiona hacia adelante hasta que un bloque tenga al menos 10."
      },
      "blocks": {
        "q": "¿Cambian los bloques horarios publicados?",
        "a": "No. Los bloques horarios publicados están diseñados para quedarse tal como se publicaron. Si se permitió volver a votar, las boletas de sustitución aparecen solo en el escrutinio final."
      }
    },
    "votes": {
      "title": "Votaciones",
      "nav": "Votaciones",
      "lede": "Una contienda cívica cuyas opciones permanecen selladas hasta el cierre.",
      "what": {
        "q": "¿Qué es una votación?",
        "a": "Una contienda cívica que mantiene las opciones selladas hasta el cierre. La participación se publica con un calendario horario diferido. No hay recuentos provisionales por opción."
      },
      "read": {
        "q": "¿Cuándo se pueden leer las opciones?",
        "a": "Al cierre, y solo en conjunto. Las opciones se cifran con una clave pública publicada en la L2. La clave privada correspondiente se reparte entre los guardianes con el esquema de secreto compartido de Shamir, diseñado para que nadie por sí solo, ni siquiera el operador, pueda descifrar antes de tiempo. El diseño no da al operador ninguna parte de la clave."
      },
      "why": {
        "q": "¿Por qué elegir una votación en lugar de una encuesta?",
        "a": "Cuando un recuento por opción en curso añadiría presión. Nada de lo que recibe un votante está diseñado para demostrar su opción a quien lo presione."
      },
      "rank": {
        "q": "¿Una votación puede ser de voto rankeado?",
        "a": "Sí, como opción activable. El voto rankeado también está disponible en las encuestas. En una votación sellada, los guardianes ven entonces cada clasificación, no la identidad."
      }
    },
    "results": {
      "title": "Resultados",
      "nav": "Resultados",
      "lede": "Qué se ve mientras una contienda está abierta y qué se publica después del cierre.",
      "open": {
        "q": "¿Qué se publica mientras una contienda está abierta?",
        "a": "La participación se publica con un calendario horario diferido en ambos tipos. Una encuesta también publica los recuentos por opción con ese calendario cuando 100 votantes hayan emitido su primera boleta, o al llegar el fin programado, lo que ocurra primero. Una votación publica las opciones solo al cierre."
      },
      "deadline": {
        "q": "¿Qué ocurre al cierre?",
        "a": "No se aceptan más boletas. Un lote final va a Ethereum al cierre. Un plazo de impugnación, que debe ser mayor que cero, llega antes del escrutinio final."
      },
      "extra": {
        "q": "¿Qué es el lote complementario?",
        "a": "Tras el periodo de gracia, cualquiera puede publicar un lote final que falte y el lote complementario, antes del escrutinio final."
      },
      "execute": {
        "q": "¿El escrutinio lleva a cabo la decisión?",
        "a": "No. Aprobar una votación nunca ejecuta nada por sí sola. Los resultados se pueden verificar. Actuar sobre ellos queda en manos de la gente."
      },
      "check": {
        "q": "¿Cómo puede comprobarlo alguien de fuera?",
        "a": "Cualquiera puede comprobar que los totales publicados coinciden con las boletas aceptadas. Un auditor independiente está pensado para poder reconstruir un resultado publicado sin la base de datos privada del operador. Hasta que exista un verificador agregado real, el recuento se comprueba sumando textos cifrados en cadena."
      }
    },
    "privacy": {
      "title": "Privacidad",
      "nav": "Privacidad",
      "lede": "La opción es el secreto. El proceso es la parte pública.",
      "private": {
        "q": "¿Qué está diseñado para seguir en privado?",
        "a": "La opción de una boleta cívica. Está diseñada para no ser nunca un campo legible en una transacción ni en una base de datos. Los recibos son hashes, diseñados para no mostrar cómo votaste."
      },
      "public": {
        "q": "¿Qué es público?",
        "a": "Los registros y los códigos de inhabilitación son públicos. La participación se publica con un calendario horario diferido en ambos tipos. Una encuesta también publica los recuentos por opción con ese calendario cuando 100 votantes hayan emitido su primera boleta, o al llegar el fin programado, lo que ocurra primero. El escrutinio final también es público."
      },
      "delay": {
        "q": "¿Por qué esperar para publicar la participación?",
        "a": "Para que salir de un lugar de votación no pueda casarse con un movimiento en vivo. El retraso es el calendario horario. Los recuentos no llevan relleno."
      },
      "signal": {
        "q": "¿Una señal con token es privada?",
        "a": "No. En una señal con token la opción sigue siendo pública. El voto secreto es la elección cívica."
      }
    },
    "officers": {
      "title": "Autoridades",
      "nav": "Autoridades",
      "lede": "El grupo que aloja el nodo es dueño del padrón. Las autoridades tienen tareas, no una clave maestra.",
      "who": {
        "q": "¿Quién opera un nodo?",
        "a": "El grupo que lo aloja. Es dueño del nodo, del padrón y del registro. No hace falta una cuenta de proveedor para empezar, y no hay dependencia de un proveedor."
      },
      "jobs": {
        "q": "¿Qué hacen las autoridades?",
        "a": "Crean la elección y la boleta, congelan el padrón, aprueban la inscripción, registran una inhabilitación con un código de motivo público y publican el escrutinio después del cierre. Quien aloja también puede publicar sus propias páginas."
      },
      "read": {
        "q": "¿Puede una autoridad leer cómo votó la gente?",
        "a": "Ese no es el diseño. Las opciones de una votación se cifran con la clave de los guardianes, y el operador no tiene ninguna parte de la clave. Una encuesta publica agregados. Las autoridades no reciben un canal privado en vivo de las opciones."
      }
    },
    "dq": {
      "title": "Inhabilitación",
      "nav": "Inhabilitación",
      "lede": "Inhabilitar a alguien es un cambio público y codificado. No es una marca silenciosa.",
      "why": {
        "q": "¿Por qué se puede inhabilitar a una persona inscrita?",
        "a": "Inscrito no es lo mismo que habilitado. Una autoridad puede inhabilitar a alguien con un código de motivo declarado, por ejemplo no tener la edad, no ser residente, un duplicado o una orden judicial. El código es público para que una depuración no pueda ocultarse."
      },
      "evidence": {
        "q": "¿Adónde va la evidencia?",
        "a": "La evidencia personal permanece fuera de la cadena. El registro público es el código de motivo y un hash de la evidencia, para que una revisión posterior pueda emparejar un archivo sellado con lo que se publicó."
      },
      "barred": {
        "q": "¿Puede votar de todos modos una persona inhabilitada?",
        "a": "No. El conjunto habilitado son las personas inscritas y no inhabilitadas en este momento. La prueba está diseñada para exigir la pertenencia a ese conjunto. Con el verificador simulado en las pruebas, esta comprobación aún no se exige."
      }
    },
    "receipts": {
      "title": "Recibos",
      "nav": "Recibos",
      "lede": "Prueba de que votó. No prueba de la opción que marcó.",
      "what": {
        "q": "¿Qué hay en un recibo?",
        "a": "Hashes que muestran que una boleta fue aceptada. Bastan para buscarla, no la opción que se marcó. Si una pantalla dice qué opción eligió, eso es un fallo."
      },
      "check": {
        "q": "¿Cómo compruebo que se contó?",
        "a": "En el nodo que ejecutó la elección, abra la página del recibo y pegue la prueba, o use el archivo que le dio el nodo. La comprobación responde si esa boleta fue aceptada. No muestra una candidatura."
      },
      "pressure": {
        "q": "¿Alguien puede exigir mi recibo como prueba de mi opción?",
        "a": "Un recibo está diseñado para no mostrar cómo votaste. No puede satisfacer a quien exige una prueba de la opción. Esa negativa es intencional."
      }
    },
    "token": {
      "title": "No es un token",
      "nav": "No es un token",
      "lede": "No hay un token del proyecto, no hay recompensa por votar y no hay nada que depositar.",
      "product": {
        "q": "¿Hay un token de {brand}?",
        "a": "No. No hay token de producto, no hay nivel de pago y no hay recompensa por votar. La licencia es AGPL-3.0-or-later. El repositorio no es una forma de ganar dinero."
      },
      "signal": {
        "q": "Entonces, ¿qué es una señal con token?",
        "a": "Un modo consultivo opcional en la red principal de Ethereum. Quien aloja elige un ERC-20 ya existente. El peso sale de ese token en un bloque finalizado. Allí se lee el poder de voto delegado. No es un voto secreto, no usa el padrón cívico y el resultado no ejecuta nada."
      },
      "markets": {
        "q": "¿Hay programas de incentivos o fondos de liquidez?",
        "a": "No. No hay nada que depositar, prestar, pedir prestado, liquidar ni subastar. No envíe fondos a quien anuncie una venta de tokens con este nombre."
      }
    },
    "community": {
      "title": "Comunidad",
      "nav": "Comunidad",
      "lede": "Un foro y un repositorio público. No una ronda de subvenciones.",
      "talk": {
        "q": "¿Dónde habla la gente?",
        "a": "En el foro de la comunidad. Los grupos conversan sobre usos reales, cómo ejecutar un nodo y qué construir después."
      },
      "grants": {
        "q": "¿Hay un programa de subvenciones?",
        "a": "No hay subvenciones en tokens ni una votación de financiación. La contribución es la habitual del código abierto: leer el código, abrir una incidencia o enviar un parche."
      },
      "help": {
        "q": "¿Pueden ayudar a un grupo a ponerse en marcha?",
        "a": "Sí. El proyecto está disponible para contratar una implementación local. Use la dirección de correo del pie del sitio."
      }
    },
    "runs": {
      "title": "Dónde se ejecuta",
      "nav": "Dónde se ejecuta",
      "lede": "Las boletas cívicas se liquidan en Ethereum. No hay un puente entre mercados de préstamo, porque no hay mercados de préstamo.",
      "land": {
        "q": "¿Dónde llegan las boletas cívicas?",
        "a": "En la L2 cívica del grupo, un secuenciador y un probador hechos a propósito. Los lotes finales se liquidan en Ethereum para que el registro sobreviva a cualquier operador. La actividad diaria no es una cadena de propósito general y no hace de puente para depósitos."
      },
      "signal": {
        "q": "¿Dónde llegan las señales con token?",
        "a": "Solo en la red principal de Ethereum. Ese modo necesita un RPC de la red principal de Ethereum. No usa la L2 cívica."
      },
      "addresses": {
        "q": "¿Hay una lista única de direcciones oficiales de contratos?",
        "a": "Aquí no se publica un despliegue global único como tabla para copiar. Cada grupo fija los contratos que usa su propio nodo. El nodo de demostración sirve para probar el software, no para una elección de producción."
      },
      "rebuild": {
        "q": "¿Se pueden reconstruir los resultados si un nodo desaparece?",
        "a": "Liquidar en Ethereum es lo que lo hace posible. Los resultados están diseñados para reconstruirse con los datos de la L2 o con el registro de L1. Una raíz no probada no publica nada y puede revertirse tras un plazo."
      }
    },
    "fits": {
      "title": "Cómo encaja",
      "nav": "Cómo encaja",
      "lede": "Muchas L2 cívicas independientes. Un registro compartido en Ethereum.",
      "picture": {
        "q": "¿Cuál es el panorama?",
        "a": "Cualquiera puede ejecutar una L2 cívica, y no hay límite de cuántas existen. Cada L2 puede contener cualquier número de elecciones. Cada L2 liquida sus lotes de votos en Ethereum, identificados por el hash del ID de la L2 y el UUID de la elección."
      },
      "inside": {
        "q": "¿Qué ocurre dentro de una L2?",
        "a": "Quienes votan en el borde votan gratis. Solo se acepta a votantes preaprobados. El secuenciador agrupa los votos. La L2 calcula la raíz de estado y el recuento. L1 consigna esa raíz cada hora y está diseñada para comprobar una prueba del cálculo después, en orden. Hasta que exista un verificador agregado real, el recuento se comprueba sumando textos cifrados en cadena."
      },
      "drawing": {
        "q": "¿Dónde está el diagrama?",
        "a": "La página de inicio lo dibuja: una vista macro de muchas L2, una vista L2 de un equipo electoral y el recorrido que siguen una encuesta y una votación hasta el escrutinio final. Esas figuras son el diagrama del protocolo."
      }
    },
    "roadmap": {
      "title": "Hoja de ruta",
      "nav": "Hoja de ruta",
      "lede": "Qué es cierto en esta línea de desarrollo, y qué no empezará a hacer después un escrutinio.",
      "today": {
        "q": "¿Qué es cierto hoy?",
        "a": "Puede leer este sitio y probar la demostración de votación. Las pruebas usan un verificador simulado. La ceremonia de configuración de confianza todavía no ocurre. No lo use hoy para una elección vinculante."
      },
      "proving": {
        "q": "¿Cuál es la ruta de prueba?",
        "a": "Una comprobación real de la prueba está en curso. Con el verificador simulado en las pruebas, el rechazo de un votante que no está preaprobado aún no se exige. No describa una demostración local como lista para una elección vinculante."
      },
      "never": {
        "q": "¿Qué no hará un resultado?",
        "a": "No se ejecutará por sí solo. El escrutinio es evidencia. Actuar sobre él queda en manos de la gente. El proyecto tampoco añadirá un token de producto ni una tarifa para quien vota."
      }
    },
    "builder": {
      "title": "Kit para construir",
      "nav": "Kit para construir",
      "lede": "El repositorio es el kit de partida. Bifúrquelo y conserve la etiqueta de sin fines de lucro.",
      "repo": {
        "q": "¿Qué hay en el repositorio?",
        "a": "El nodo, la L2 cívica, los contratos y los circuitos, juntos, bajo AGPL-3.0-or-later. Un grupo no debe depender de una compilación privada de un proveedor. Bifúrquelo y conserve la etiqueta de sin fines de lucro."
      },
      "read": {
        "q": "¿Qué debo leer primero?",
        "a": "El README en la raíz del repositorio y después las guías de autoalojamiento. Cada nodo en marcha sirve esas guías en /docs."
      },
      "agpl": {
        "q": "¿Qué pide la AGPL a quien aloja?",
        "a": "Si ejecuta un nodo modificado como servicio de red, ofrezca el código fuente correspondiente a quienes usan ese servicio."
      }
    }
  }
};
